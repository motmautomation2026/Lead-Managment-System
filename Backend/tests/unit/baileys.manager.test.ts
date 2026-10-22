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
  loadBaileysAuthState: vi.fn(),
  clearBaileysAuthState: vi.fn(),
}));
vi.mock("../../src/services/whatsapp-inbound.service.js", () => ({ processInboundUpsert: vi.fn() }));
vi.mock("../../src/supabaseAdmin.js", () => ({ supabaseAdmin: {} }));

import { BaileysManager, resolveLeadIdForSource, type WhatsAppSendSource } from "../../src/providers/baileys.manager.js";
import { PermanentProviderError } from "../../src/providers/provider-errors.js";

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
