/**
 * E1 WhatsApp safety on the real send path: BaileysManager.performSend with a fake
 * socket (never a real WhatsApp connection) against the test database, one fresh
 * `[test]` workspace per scenario so pauses and counts never leak between tests.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import type { Actor } from "../../src/authMiddleware.js";
import type { BaileysManager, WhatsAppSendSource } from "../../src/providers/baileys.manager.js";
import { PermanentProviderError, ProviderDeferredError } from "../../src/providers/provider-errors.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const PAUSE_TITLE = "WhatsApp sending paused automatically";

describeIfDb("WhatsApp safety on the send path (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let admin: Actor;
  let Manager: typeof BaileysManager;
  const authUserIds: string[] = [];

  async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const randomPhone = () => `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const jidOf = (phone: string) => `${phone.slice(1)}@s.whatsapp.net`;

  /** A connected, enabled workspace whose send window is always open unless `days` says otherwise. */
  async function workspace(label: string, settings: Record<string, unknown> = {}) {
    const ws = await createTestWorkspace(pool, `wa-safety-${label}`);
    await pool.query(
      `insert into public.whatsapp_connection (workspace_id, enabled, status, desired_state, send_window_days, send_window_start, send_window_end)
       values ($1, true, 'connected', 'connected', '{1,2,3,4,5,6,7}', '00:00', '23:59:59')`,
      [ws],
    );
    const entries = Object.entries(settings);
    if (entries.length) {
      await pool.query(
        `update public.whatsapp_connection set ${entries.map(([key], i) => `${key} = $${i + 2}`).join(", ")} where workspace_id = $1`,
        [ws, ...entries.map(([, value]) => value)],
      );
    }
    return ws;
  }

  async function lead(ws: string, phone = randomPhone()) {
    const { createLead } = await import("../../src/services/leads.service.js");
    const created = await inTransaction((client) =>
      createLead(client, admin, ws, { firstName: "Wren", company: "Wren Pvt Ltd", source: "referral", email: `wren-${randomUUID()}@example.com`, phone }),
    );
    return { id: created.id, phone };
  }

  /** A rep's proposal send, claimed (`sending`). */
  async function proposalSource(ws: string, leadId: string): Promise<WhatsAppSendSource> {
    const { createProposal } = await import("../../src/services/proposals.service.js");
    const proposal = await inTransaction((client) => createProposal(client, admin, ws, { leadId, title: "Safety proposal", whatsappSendStatus: "skipped" }));
    await pool.query(`update public.proposals set whatsapp_send_status = 'sending' where id = $1`, [proposal.id]);
    return { type: "proposal", id: proposal.id };
  }

  /** A workflow send_whatsapp step, claimed as the worker would (`executing`). */
  async function workflowSource(ws: string, leadId: string): Promise<WhatsAppSendSource> {
    const { createTemplate, createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const { enrollLeadInWorkflow } = await import("../../src/services/runs.service.js");
    const template = await inTransaction((client) => createTemplate(client, admin, ws, { name: `E1 ${randomUUID()}`, channel: "whatsapp", body: "Hi" }));
    const workflow = await inTransaction((client) => createWorkflow(client, admin, ws, { name: `E1 ${randomUUID()}`, trigger: "manual_enrollment" }));
    // delayDays 1 keeps a live staging worker from claiming the action first.
    await inTransaction((client) =>
      updateDraftSteps(client, ws, workflow.id, 1, [{ order: 0, delayDays: 1, action: "send_whatsapp", templateId: template.id, enabled: true }]),
    );
    await inTransaction((client) => publishVersion(client, admin, ws, workflow.id, 1, "keep_existing"));
    await inTransaction((client) => updateWorkflow(client, ws, workflow.id, { status: "active" }));
    const run = await inTransaction((client) => enrollLeadInWorkflow(client, ws, leadId, workflow.id, "E1 test"));
    const claimed = await pool.query<{ id: string }>(
      `update public.scheduled_actions set status = 'executing', last_attempt_at = now() where workflow_run_id = $1 returning id`,
      [run!.id],
    );
    return { type: "scheduled_action", id: claimed.rows[0]!.id };
  }

  /** `count` sent messages today (fillers on proposals of one lead), optionally first chats. */
  async function sentToday(ws: string, count: number, newChat = false) {
    const filler = await lead(ws);
    await pool.query(
      `with p as (
         insert into public.proposals (workspace_id, lead_id, title)
         select $1, $2, 'filler' from generate_series(1, $3) returning id
       )
       insert into public.whatsapp_outbound_messages (workspace_id, proposal_id, message_id, remote_jid, status, sent_at, new_chat)
       select $1, p.id, 'FILL-' || gen_random_uuid(), '910000000000@s.whatsapp.net', 'sent', now(), $4 from p`,
      [ws, filler.id, count, newChat],
    );
  }

  function fakeSocket(options: { registered?: boolean; restricted?: boolean; sendError?: Error } = {}) {
    return {
      user: { id: "919999999999:1@s.whatsapp.net" },
      fetchAccountReachoutTimelock: vi.fn(async () => (options.restricted ? { isActive: true } : null)),
      fetchNewChatMessageCap: vi.fn(async () => null),
      onWhatsApp: vi.fn(async (number: string) => [{ exists: options.registered ?? true, jid: `${number}@s.whatsapp.net` }]),
      sendMessage: vi.fn(async (_jid: string, content: { text?: string }) => {
        if (options.sendError) throw options.sendError;
        return { message: { conversation: content.text ?? "" } };
      }),
      sendPresenceUpdate: vi.fn(async (_type: string, _jid?: string) => undefined),
    };
  }

  function manager(ws: string, socket: ReturnType<typeof fakeSocket>) {
    const m = new Manager(ws, async () => undefined);
    Object.assign(m as unknown as Record<string, unknown>, { socket, connected: true });
    return m;
  }

  const send = (m: BaileysManager, source: WhatsAppSendSource, phone: string, body = "Hello there") =>
    m.sendAction({ source, phoneE164: phone, body }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: error as Error }),
    );

  async function connection(ws: string) {
    return (await pool.query(`select enabled, paused_reason, paused_at, next_send_at from public.whatsapp_connection where workspace_id = $1`, [ws])).rows[0];
  }

  async function pauseNotifications(ws: string) {
    return (await pool.query<{ n: number }>(`select count(*)::int as n from public.notifications where workspace_id = $1 and title = $2`, [ws, PAUSE_TITLE])).rows[0]!.n;
  }

  async function activeAdmins() {
    return (await pool.query<{ n: number }>(`select count(*)::int as n from public.profiles where role = 'admin' and is_active`)).rows[0]!.n;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    ({ BaileysManager: Manager } = await import("../../src/providers/baileys.manager.js"));
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`wa-safety-${randomUUID()}@example.com`]);
    authUserIds.push(auth.rows[0].id as string);
    const profile = await pool.query(
      `update public.profiles set role = 'admin', is_active = true, full_name = 'E1 Admin' where id = $1 returning id, full_name, email`,
      [auth.rows[0].id],
    );
    admin = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "admin" };
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    for (const id of authUserIds) {
      await pool.query(`delete from auth.users where id = $1`, [id]).catch((error) => console.warn("[whatsappSafety] test user cleanup failed:", error));
    }
    await pool.end();
  });

  it("outside the send window defers a workflow send but not a rep's proposal send", async () => {
    // Every weekday except today's (IST) is in the window.
    const today = (await pool.query<{ d: number }>(`select extract(isodow from now() at time zone 'Asia/Kolkata')::int as d`)).rows[0]!.d;
    const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today);
    const ws = await workspace("window", { send_window_days: days });
    const socket = fakeSocket();
    const m = manager(ws, socket);

    const workflowLead = await lead(ws);
    const workflow = await send(m, await workflowSource(ws, workflowLead.id), workflowLead.phone);
    expect(workflow.ok).toBe(false);
    expect(workflow.ok || workflow.error).toBeInstanceOf(ProviderDeferredError);
    expect(workflow.ok || workflow.error.message).toBe("Outside the WhatsApp send window.");
    expect(workflow.ok || (workflow.error as ProviderDeferredError).retryAfterMs).toBeGreaterThan(60 * 60_000);

    const repLead = await lead(ws);
    expect(await send(m, await proposalSource(ws, repLead.id), repLead.phone)).toMatchObject({ ok: true });
    expect(socket.sendMessage).toHaveBeenCalledOnce();
  });

  it("warm-up: day 2 after pairing caps the day at 20", async () => {
    const ws = await workspace("warmup", { paired_at: new Date(Date.now() - 24 * 3_600_000), daily_cap: 200 });
    await sentToday(ws, 20);
    const contact = await lead(ws);
    const result = await send(manager(ws, fakeSocket()), await proposalSource(ws, contact.id), contact.phone);
    expect(result.ok || result.error).toBeInstanceOf(ProviderDeferredError);
    expect(result.ok || result.error.message).toBe("Warm-up daily cap (20) reached.");
  });

  it("the 21st first message of the day defers; a known contact still gets one", async () => {
    const ws = await workspace("new-chats");
    await sentToday(ws, 20, true);
    const socket = fakeSocket();
    const m = manager(ws, socket);

    const stranger = await lead(ws);
    const deferred = await send(m, await proposalSource(ws, stranger.id), stranger.phone);
    expect(deferred.ok || deferred.error.message).toBe("New-chat limit (20 per day) reached.");

    const known = await lead(ws);
    await pool.query(
      `insert into public.whatsapp_inbound_events (workspace_id, message_id, sender_jid, sender_phone_e164, message_type, received_at, disposition)
       values ($1, $2, $3, $4, 'conversation', now() - interval '2 days', 'matched')`,
      [ws, `E1-IN-${randomUUID()}`, jidOf(known.phone), known.phone],
    );
    expect(await send(m, await proposalSource(ws, known.id), known.phone)).toMatchObject({ ok: true });
    const row = await pool.query(`select new_chat from public.whatsapp_outbound_messages where workspace_id = $1 and remote_jid = $2`, [ws, jidOf(known.phone)]);
    expect(row.rows[0]).toEqual({ new_chat: false });
  });

  it("a first workflow message with a link fails permanently with the reason; the run shows it", async () => {
    const ws = await workspace("link");
    const socket = fakeSocket();
    const contact = await lead(ws);
    const source = await workflowSource(ws, contact.id);
    const result = await send(manager(ws, socket), source, contact.phone, "Hi, see https://acme.com/offer");
    expect(result.ok || result.error).toBeInstanceOf(PermanentProviderError);
    expect(result.ok || result.error.message).toBe("First WhatsApp message can't contain a link");
    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(socket.onWhatsApp).not.toHaveBeenCalled();

    const outbound = await pool.query(`select status, last_error from public.whatsapp_outbound_messages where scheduled_action_id = $1`, [source.id]);
    expect(outbound.rows[0]).toEqual({ status: "failed", last_error: "First WhatsApp message can't contain a link" });
    // The worker records it like any permanent failure.
    const { recordActionResult } = await import("../../src/services/automation.service.js");
    await inTransaction((client) => recordActionResult(client, source.id, { outcome: "failure", error: result.ok ? "" : result.error.message, retryable: false }));
    const action = await pool.query(`select a.status, a.last_error, r.status as run_status from public.scheduled_actions a join public.workflow_runs r on r.id = a.workflow_run_id where a.id = $1`, [source.id]);
    expect(action.rows[0]).toMatchObject({ status: "failed", last_error: "First WhatsApp message can't contain a link" });
  });

  it("appends the opt-out line once to a first workflow message, never to a rep's or a later one", async () => {
    const ws = await workspace("opt-out");
    const socket = fakeSocket();
    const m = manager(ws, socket);

    const a = await lead(ws);
    await send(m, await workflowSource(ws, a.id), a.phone, "Hi Asha");
    const b = await lead(ws);
    await pool.query(`update public.whatsapp_connection set next_send_at = null where workspace_id = $1`, [ws]);
    await send(m, await workflowSource(ws, b.id), b.phone, "Hi Bo\n\nReply STOP to opt out.");
    await pool.query(`update public.whatsapp_connection set next_send_at = null where workspace_id = $1`, [ws]);
    await send(m, await proposalSource(ws, a.id), a.phone, "Your proposal");

    const texts = socket.sendMessage.mock.calls.map(([, content]) => content.text);
    expect(texts).toEqual(["Hi Asha\n\nReply STOP to opt out.", "Hi Bo\n\nReply STOP to opt out.", "Your proposal"]);
    expect(socket.sendPresenceUpdate.mock.calls.map(([type]) => type)).toEqual(["composing", "paused", "composing", "paused", "composing", "paused"]);
  });

  it("spacing: the next send right after one defers until next_send_at (45–120 s)", async () => {
    const ws = await workspace("spacing");
    const m = manager(ws, fakeSocket());
    const a = await lead(ws);
    expect(await send(m, await proposalSource(ws, a.id), a.phone)).toMatchObject({ ok: true });
    const { next_send_at } = await connection(ws);
    const gap = (next_send_at as Date).getTime() - Date.now();
    expect(gap).toBeGreaterThan(20_000);
    expect(gap).toBeLessThanOrEqual(120_000);

    const b = await lead(ws);
    const second = await send(m, await proposalSource(ws, b.id), b.phone);
    expect(second.ok || second.error.message).toBe("Spacing WhatsApp sends.");
  });

  describe("auto-pause (rule 7)", () => {
    async function expectPausedOnce(ws: string, reason: RegExp) {
      const state = await connection(ws);
      expect(state.enabled).toBe(false);
      expect(state.paused_reason).toMatch(reason);
      expect(await pauseNotifications(ws)).toBe(await activeAdmins());
      const events = await pool.query(`select count(*)::int as n from public.whatsapp_safety_events where workspace_id = $1 and kind = 'paused'`, [ws]);
      expect(events.rows[0].n).toBe(1);
    }

    async function expectLaterSendsDefer(ws: string) {
      const contact = await lead(ws);
      const socket = fakeSocket();
      const result = await send(manager(ws, socket), await proposalSource(ws, contact.id), contact.phone);
      expect(result.ok || result.error).toBeInstanceOf(ProviderDeferredError);
      expect(result.ok || result.error.message).toMatch(/^WhatsApp sending is paused/);
      expect(socket.sendMessage).not.toHaveBeenCalled();
      return contact;
    }

    it("5 send failures within 30 min pause, notify admins once, and later sends defer", async () => {
      const ws = await workspace("failures");
      await pool.query(
        `insert into public.whatsapp_safety_events (workspace_id, kind, detail) select $1, 'send_failed', 'earlier' from generate_series(1, 4)`,
        [ws],
      );
      const contact = await lead(ws);
      const failing = await send(manager(ws, fakeSocket({ sendError: new Error("rate-overlimit") })), await proposalSource(ws, contact.id), contact.phone);
      expect(failing.ok || failing.error.message).toBe("rate-overlimit");
      await expectPausedOnce(ws, /5 WhatsApp send failures in 30 minutes/);
      await expectLaterSendsDefer(ws);
      await expectPausedOnce(ws, /5 WhatsApp send failures/);
    });

    it("'not on WhatsApp' is not a failure signal", async () => {
      const ws = await workspace("not-registered");
      const m = manager(ws, fakeSocket({ registered: false }));
      for (let i = 0; i < 5; i++) {
        const contact = await lead(ws);
        const result = await send(m, await proposalSource(ws, contact.id), contact.phone);
        expect(result.ok || result.error.message).toBe("Recipient is not registered on WhatsApp.");
      }
      expect((await connection(ws)).enabled).toBe(true);
      // The not-registered mark is kept (the claim transaction commits it).
      const invalid = await pool.query(
        `select count(*)::int as n from public.lead_contact_channels c join public.leads l on l.id = c.lead_id
          where l.workspace_id = $1 and c.channel = 'whatsapp' and c.status = 'invalid'`,
        [ws],
      );
      expect(invalid.rows[0].n).toBe(5);
    });

    it("3 STOP replies in 24 h pause; an admin's resume lets sends go again", async () => {
      const ws = await workspace("stops");
      await pool.query(
        `insert into public.whatsapp_inbound_events (workspace_id, message_id, sender_jid, sender_phone_e164, message_type, received_at, disposition, reply_label)
         select $1, 'E1-STOP-' || gen_random_uuid(), '910000000001@s.whatsapp.net', '+910000000001', 'conversation', now() - interval '1 hour', 'matched', 'asked_to_stop'
           from generate_series(1, 3)`,
        [ws],
      );
      const contact = await expectLaterSendsDefer(ws);
      await expectPausedOnce(ws, /3 contacts asked us to stop in 24 hours/);
      await expectLaterSendsDefer(ws);
      await expectPausedOnce(ws, /3 contacts asked us to stop/);

      const { resumeSending } = await import("../../src/services/whatsappSafety.service.js");
      await inTransaction((client) => resumeSending(client, admin, ws));
      const socket = fakeSocket();
      expect(await send(manager(ws, socket), await proposalSource(ws, contact.id), contact.phone)).toMatchObject({ ok: true });
      expect(await connection(ws)).toMatchObject({ enabled: true, paused_reason: null });
    });

    it("5 % STOPs of ≥ 40 sends in 24 h pause", async () => {
      const ws = await workspace("stop-rate");
      await sentToday(ws, 40);
      await pool.query(
        `insert into public.whatsapp_inbound_events (workspace_id, message_id, sender_jid, sender_phone_e164, message_type, received_at, disposition, reply_label)
         select $1, 'E1-STOP-' || gen_random_uuid(), '910000000001@s.whatsapp.net', '+910000000001', 'conversation', now(), 'matched', 'asked_to_stop'
           from generate_series(1, 2)`,
        [ws],
      );
      await expectLaterSendsDefer(ws);
      await expectPausedOnce(ws, /2 of 40 contacts asked us to stop/);
    });

    it("a reach-out / new-chat restriction from WhatsApp pauses", async () => {
      const ws = await workspace("restricted");
      const contact = await lead(ws);
      const result = await send(manager(ws, fakeSocket({ restricted: true })), await proposalSource(ws, contact.id), contact.phone);
      expect(result.ok || result.error).toBeInstanceOf(ProviderDeferredError);
      await expectPausedOnce(ws, /restriction/);
    });
  });
});
