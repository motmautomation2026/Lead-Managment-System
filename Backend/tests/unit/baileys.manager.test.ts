import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  txQuery: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({
  pool: { query: mocks.poolQuery },
  withTransaction: async (fn: (db: { query: typeof mocks.txQuery }) => Promise<unknown>) => fn({ query: mocks.txQuery }),
  pgConnectionOptions: { connectionString: "postgres://test" },
}));
vi.mock("../../src/providers/baileys-auth.store.js", () => ({
  loadBaileysAuthState: vi.fn(async () => ({ state: { creds: {} }, saveCreds: vi.fn() })),
  clearBaileysAuthState: vi.fn(),
}));
const pgMocks = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  class FakeClient extends EventEmitter {
    static instances: FakeClient[] = [];
    static locked = true;
    connect = vi.fn(async () => undefined);
    end = vi.fn(async () => {
      this.emit("end");
    });
    query = vi.fn(async (sql: string) => (sql.includes("pg_try_advisory_lock") ? { rows: [{ locked: FakeClient.locked }] } : { rows: [] }));
    constructor(readonly options: unknown) {
      super();
      FakeClient.instances.push(this);
    }
  }
  const fakeSocket = { ev: { on: vi.fn() }, end: vi.fn() };
  return { FakeClient, fakeSocket, makeWASocket: vi.fn(() => fakeSocket) };
});
vi.mock("pg", () => ({ Client: pgMocks.FakeClient }));
vi.mock("baileys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("baileys")>()),
  default: pgMocks.makeWASocket,
}));
vi.mock("../../src/services/whatsapp-inbound.service.js", () => ({ processInboundUpsert: vi.fn() }));
vi.mock("../../src/supabaseAdmin.js", () => ({ supabaseAdmin: {} }));

import { BaileysManager, resolveLeadIdForSource, type WhatsAppSendSource } from "../../src/providers/baileys.manager.js";
import { PermanentProviderError, ProviderDeferredError } from "../../src/providers/provider-errors.js";
import { supabaseAdmin } from "../../src/supabaseAdmin.js";
import { DisconnectReason } from "baileys";

const WS = "ws-1";
const PHONE = "+919876543210";
const JID = "919876543210@s.whatsapp.net";

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

// Copied verbatim from performSend before the B1 refactor, to pin them.
const SCHEDULED_ACTION_ELIGIBILITY_SQL = norm(`select l.phone_e164
                 from public.scheduled_actions a
                 join public.leads l on l.id = a.lead_id
                 join public.workflow_runs r on r.id = a.workflow_run_id
                where a.id = $1 and a.workspace_id = $2 and a.status = 'executing'
                  and l.lifecycle_state = 'active' and l.automation_mode not in ('manual','paused','stopped')
                  and r.status in ('running','waiting')
                for update of a, l, r`);
const PROPOSAL_ELIGIBILITY_SQL = norm(`select l.phone_e164
                 from public.proposals p
                 join public.leads l on l.id = p.lead_id
                where p.id = $1 and p.workspace_id = $2 and p.whatsapp_send_status = 'sending'
                  and l.lifecycle_state != 'do_not_contact'
                for update of p, l`);

interface FakeOptions {
  /** Rows returned by the source eligibility query. */
  eligibility: Record<string, unknown>[];
  registered?: boolean;
}

/** Answers performSend's transaction queries; records every call. */
function installFakeDb({ eligibility, registered = true }: FakeOptions) {
  mocks.txQuery.mockImplementation(async (sql: string) => {
    const s = norm(sql);
    if (s.startsWith("select message_id, remote_jid, status from public.whatsapp_outbound_messages")) {
      return { rows: [{ message_id: "MSG-1", remote_jid: JID, status: "prepared" }] };
    }
    if (s.startsWith("select * from public.whatsapp_connection")) {
      return {
        rows: [
          {
            enabled: true,
            status: "connected",
            daily_cap: 100,
            min_delay_seconds: 0,
            max_delay_seconds: 0,
            reachout_lock: null,
            new_chat_cap: null,
          },
        ],
      };
    }
    if (s.startsWith("select count(*)")) return { rows: [{ count: "0" }] };
    if (s.startsWith("select max(sent_at)")) return { rows: [{ sent_at: null }] };
    if (/^select .* from public\.(scheduled_actions|proposals|meetings) /.test(s) && s.includes("for update")) {
      return { rows: eligibility };
    }
    if (s.startsWith("select lead_id from")) return { rows: [{ lead_id: "lead-1" }] };
    return { rows: [] };
  });
  mocks.poolQuery.mockResolvedValue({ rows: [{ enabled: true, status: "connected" }] });
  const socket = {
    user: { id: "919999999999:1@s.whatsapp.net" },
    fetchAccountReachoutTimelock: vi.fn(async () => null),
    fetchNewChatMessageCap: vi.fn(async () => null),
    onWhatsApp: vi.fn(async () => [{ exists: registered }]),
    sendMessage: vi.fn(async () => ({ message: { conversation: "hi" } })),
  };
  return socket;
}

function connectedManager(socket: unknown) {
  const manager = new BaileysManager(WS);
  Object.assign(manager as unknown as Record<string, unknown>, { socket, connected: true });
  return manager;
}

function send(manager: BaileysManager, source: WhatsAppSendSource) {
  return manager.sendAction({ source, phoneE164: PHONE, body: "hi" });
}

function eligibilityCall() {
  return mocks.txQuery.mock.calls.find(([sql]) => /^select .* from public\.(scheduled_actions|proposals|meetings) /.test(norm(sql)) && sql.includes("for update"));
}

function contactChannelCall() {
  return mocks.txQuery.mock.calls.find(([sql]) => norm(sql).includes("lead_contact_channels"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  { type: "scheduled_action" as const, sql: SCHEDULED_ACTION_ELIGIBILITY_SQL, table: "public.scheduled_actions" },
  { type: "proposal" as const, sql: PROPOSAL_ELIGIBILITY_SQL, table: "public.proposals" },
])("performSend pinned behaviour: $type", ({ type, sql, table }) => {
  const source = { type, id: "src-1" };

  it("runs the existing eligibility query unchanged and sends when the phone matches", async () => {
    const socket = installFakeDb({ eligibility: [{ phone_e164: PHONE }] });
    await expect(send(connectedManager(socket), source)).resolves.toEqual({ providerMessageId: "MSG-1" });
    const [eligibilitySql, params] = eligibilityCall()!;
    expect(norm(eligibilitySql)).toBe(sql);
    expect(params).toEqual(["src-1", WS]);
    expect(socket.sendMessage).toHaveBeenCalledOnce();
  });

  it("is permanently ineligible when the query returns no row", async () => {
    const socket = installFakeDb({ eligibility: [] });
    const error = await send(connectedManager(socket), source).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermanentProviderError);
    expect((error as Error).message).toBe("The lead is no longer eligible for this WhatsApp action.");
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it("is permanently ineligible when the lead phone differs", async () => {
    const socket = installFakeDb({ eligibility: [{ phone_e164: "+911111111111" }] });
    await expect(send(connectedManager(socket), source)).rejects.toBeInstanceOf(PermanentProviderError);
  });

  it(`marks the lead's WhatsApp channel invalid via ${table} when not registered`, async () => {
    const socket = installFakeDb({ eligibility: [{ phone_e164: PHONE }], registered: false });
    await expect(send(connectedManager(socket), source)).rejects.toThrow("Recipient is not registered on WhatsApp.");
    const call = contactChannelCall()!;
    expect(norm(call[0])).toContain("insert into public.lead_contact_channels");
    expect(JSON.stringify(mocks.txQuery.mock.calls)).toContain(table);
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });
});

describe("performSend: meeting source (B1)", () => {
  const source = { type: "meeting" as const, id: "meeting-1" };
  const qualifying = { notify_whatsapp_status: "sending", meeting_status: "scheduled", lifecycle_state: "active", phone_e164: PHONE };

  it("sends when the meeting row qualifies", async () => {
    const socket = installFakeDb({ eligibility: [qualifying] });
    await expect(send(connectedManager(socket), source)).resolves.toEqual({ providerMessageId: "MSG-1" });
    const [sql, params] = eligibilityCall()!;
    expect(norm(sql)).toContain("from public.meetings m join public.leads l on l.id = m.lead_id where m.id = $1 and m.workspace_id = $2");
    expect(params).toEqual(["meeting-1", WS]);
    expect(socket.sendMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ["a cancelled meeting", { meeting_status: "cancelled" }],
    ["a no-show meeting", { meeting_status: "no_show" }],
    ["a failed meeting", { meeting_status: "failed" }],
    ["a DNC lead", { lifecycle_state: "do_not_contact" }],
    ["a merged lead", { lifecycle_state: "merged" }],
    ["a status other than sending", { notify_whatsapp_status: "queued" }],
  ])("is permanently ineligible for %s", async (_label, override) => {
    const socket = installFakeDb({ eligibility: [{ ...qualifying, ...override }] });
    const error = await send(connectedManager(socket), source).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermanentProviderError);
    expect((error as Error).message).toBe("The lead is no longer eligible for this WhatsApp action.");
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it("is permanently ineligible when the meeting row is missing", async () => {
    const socket = installFakeDb({ eligibility: [] });
    await expect(send(connectedManager(socket), source)).rejects.toBeInstanceOf(PermanentProviderError);
  });
});

describe("performSend: socket lost at send time", () => {
  const source = { type: "proposal" as const, id: "src-1" };
  const attachment = { storagePath: "p/doc.pdf", fileName: "doc.pdf", mimeType: "application/pdf", bucket: "proposal-documents" };

  it("defers when the session lock drops after the final recheck, before sendMessage", async () => {
    const socket = Object.assign(installFakeDb({ eligibility: [{ phone_e164: PHONE }] }), { end: vi.fn() });
    const manager = connectedManager(socket);
    // The attachment download is the last await before the send: lose the lock there.
    Object.assign(supabaseAdmin, {
      storage: {
        from: () => ({
          download: async () => {
            await manager.stop();
            return { data: new Blob(["pdf"]), error: null };
          },
        }),
      },
    });

    const error = await manager.sendAction({ source, phoneE164: PHONE, body: "hi", attachment }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderDeferredError);
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it("defers when Baileys reports the connection closed during sendMessage (Boom 428)", async () => {
    const socket = installFakeDb({ eligibility: [{ phone_e164: PHONE }] });
    socket.sendMessage.mockRejectedValueOnce(Object.assign(new Error("Connection Closed"), { output: { statusCode: DisconnectReason.connectionClosed } }));

    await expect(send(connectedManager(socket), source)).rejects.toBeInstanceOf(ProviderDeferredError);
  });

  it("does not turn other send errors into deferrals", async () => {
    const socket = installFakeDb({ eligibility: [{ phone_e164: PHONE }] });
    socket.sendMessage.mockRejectedValueOnce(new Error("bad media"));

    const error = await send(connectedManager(socket), source).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ProviderDeferredError);
    expect((error as Error).message).toBe("bad media");
  });
});

describe("resolveLeadIdForSource", () => {
  it.each([
    ["scheduled_action", "public.scheduled_actions"],
    ["proposal", "public.proposals"],
    ["meeting", "public.meetings"],
  ] as const)("looks up %s leads in %s", async (type, table) => {
    const query = vi.fn(async () => ({ rows: [{ lead_id: "lead-9" }] }));
    await expect(resolveLeadIdForSource({ query } as never, { type, id: "src-9" })).resolves.toBe("lead-9");
    expect(query).toHaveBeenCalledWith(`select lead_id from ${table} where id = $1`, ["src-9"]);
  });

  it("returns null when the source row is gone", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(resolveLeadIdForSource({ query } as never, { type: "meeting", id: "x" })).resolves.toBeNull();
  });

  it("marks the meeting's lead invalid when the number is not registered", async () => {
    const socket = installFakeDb({
      eligibility: [{ notify_whatsapp_status: "sending", meeting_status: "scheduled", lifecycle_state: "active", phone_e164: PHONE }],
      registered: false,
    });
    await expect(send(connectedManager(socket), { type: "meeting", id: "meeting-1" })).rejects.toThrow("Recipient is not registered on WhatsApp.");
    expect(mocks.txQuery).toHaveBeenCalledWith("select lead_id from public.meetings where id = $1", ["meeting-1"]);
    expect(contactChannelCall()![1]).toEqual(["lead-1"]);
  });
});

describe("BaileysManager session lock (B18)", () => {
  const { FakeClient, fakeSocket } = pgMocks;

  beforeEach(() => {
    FakeClient.instances.length = 0;
    FakeClient.locked = true;
    mocks.poolQuery.mockImplementation(async (sql: string) =>
      sql.startsWith("select * from public.whatsapp_connection")
        ? { rows: [{ desired_state: "connected", command_version: "1" }] }
        : { rows: [] },
    );
  });

  async function startedManager() {
    const manager = new BaileysManager(WS);
    await manager.start();
    return { manager, client: FakeClient.instances[0]! };
  }

  it("takes the lock on a dedicated client built from the shared options, not the pool", async () => {
    const { manager, client } = await startedManager();
    expect(FakeClient.instances).toHaveLength(1);
    expect(client.options).toEqual({ connectionString: "postgres://test" });
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith("select pg_try_advisory_lock(hashtextextended($1, 1)) as locked", [WS]);
    expect(mocks.poolQuery.mock.calls.some(([sql]) => String(sql).includes("advisory"))).toBe(false);
    await manager.stop();
  });

  it("closes the client and throws when another worker holds the lock", async () => {
    FakeClient.locked = false;
    const manager = new BaileysManager(WS);
    await expect(manager.start()).rejects.toThrow("Another automation worker already owns this workspace's WhatsApp session");
    expect(FakeClient.instances[0]!.end).toHaveBeenCalledOnce();
    expect(manager.isStopped).toBe(true);
    expect(pgMocks.makeWASocket).not.toHaveBeenCalled();
  });

  it.each(["error", "end"] as const)("stops the socket and marks itself stopped when the lock client emits %s", async (event) => {
    const { manager, client } = await startedManager();
    expect(pgMocks.makeWASocket).toHaveBeenCalledOnce();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    client.emit(event, event === "error" ? new Error("terminating connection due to administrator command") : undefined);

    expect(manager.isStopped).toBe(true);
    expect(fakeSocket.end).toHaveBeenCalledOnce();
    const error = await send(manager, { type: "scheduled_action", id: "a-1" }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("WhatsApp is disconnected or awaiting QR pairing.");
  });

  it("unlocks and then closes the client on stop", async () => {
    const { manager, client } = await startedManager();
    await manager.stop();
    expect(client.query).toHaveBeenLastCalledWith("select pg_advisory_unlock(hashtextextended($1, 1))", [WS]);
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.query.mock.invocationCallOrder.at(-1)!).toBeLessThan(client.end.mock.invocationCallOrder[0]!);
    expect(manager.isStopped).toBe(true);
  });

  it("releases the lock if the first control sync fails, so a retry can take it", async () => {
    mocks.poolQuery.mockRejectedValueOnce(new Error("db blip"));
    const manager = new BaileysManager(WS);
    await expect(manager.start()).rejects.toThrow("db blip");
    const client = FakeClient.instances[0]!;
    expect(client.query).toHaveBeenLastCalledWith("select pg_advisory_unlock(hashtextextended($1, 1))", [WS]);
    expect(client.end).toHaveBeenCalledOnce();
  });
});
