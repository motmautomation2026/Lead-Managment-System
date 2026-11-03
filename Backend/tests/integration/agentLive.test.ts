/**
 * E2 Live mode on the real worker paths: the runner (fake DecisionModel), the AI
 * WhatsApp claim loop through BaileysManager.performSend with a fake socket, and AI
 * emails through the E1b queue with a fake SMTP transport. Never a real WhatsApp, SMTP
 * or OpenAI call; only `[test]` workspaces. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { fakeEmbedder } from "../helpers/fakeEmbedder.js";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import type { BaileysManager } from "../../src/providers/baileys.manager.js";
import type { EmailTransport, TransportCache as TransportCacheType } from "../../src/providers/email.provider.js";
import type { WhatsAppSender } from "../../src/services/agentSends.service.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const PRICES = { "m-decide": { inputPer1M: 1, outputPer1M: 1 }, "m-ground": { inputPer1M: 1, outputPer1M: 1 } };
const MODELS = { decision: "m-decide", grounding: "m-ground" };

const WHATSAPP: AgentDecision = { action: "send_whatsapp", body: "Hi Asha, following up on our call about outbound for Acme Steel. Would a short call on Tuesday work?", assetIds: [], nextWakeInDays: 3, reasoning: "Follow up." };
const EMAIL: AgentDecision = { action: "send_email", subject: "Outbound for Acme Steel", body: "Hi Asha,\n\nFollowing up on our call. Would a short call on Tuesday work?", assetIds: [], nextWakeInDays: 3, reasoning: "Follow up." };

describeIfDb("E2 AI live mode (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let adminId: string;
  let Manager: typeof BaileysManager;
  let TransportCache: typeof TransportCacheType;

  const randomPhone = () => `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  /** A live workspace (scope test_contacts), every window open, WhatsApp connected, SMTP configured, IMAP healthy. */
  async function workspace(label: string) {
    const ws = await createTestWorkspace(pool, `live-${label}`);
    await pool.query(`insert into public.agent_playbooks (workspace_id, version, body, created_by_name) values ($1, 1, 'Be helpful.', 'Test')`, [ws]);
    await pool.query(
      `update public.agent_settings
          set mode = 'live', live_scope = 'test_contacts', send_days = '{1,2,3,4,5,6,7}', send_window_start = '00:00', send_window_end = '23:59:59',
              current_playbook_version = 1, company_display_name = 'MOTM Technologies', rep_quiet_hours = 0
        where workspace_id = $1`,
      [ws],
    );
    await pool.query(
      `insert into public.whatsapp_connection (workspace_id, enabled, status, desired_state, send_window_days, send_window_start, send_window_end)
       values ($1, true, 'connected', 'connected', '{1,2,3,4,5,6,7}', '00:00', '23:59:59')`,
      [ws],
    );
    const { encryptJson } = await import("../../src/security/encryption.js");
    const secret = encryptJson({ smtpUsername: "crm@motm.example", smtpPassword: "app-password" }, "integration:email");
    await pool.query(
      `insert into public.integration_connections
         (workspace_id, id, provider, enabled, settings, secret_ciphertext, secret_iv, secret_tag, key_version,
          send_window_days, send_window_start, send_window_end, min_delay_seconds, max_delay_seconds)
       values ($1, 'email', 'smtp', true, $2, $3, $4, $5, $6, '{1,2,3,4,5,6,7}', '00:00', '23:59:59', 1, 1)`,
      [ws, { senderName: "MOTM Sales", senderAddress: "crm@motm.example", replyTo: "replies@motm.example", smtpHost: "smtp.motm.example", smtpPort: 465, smtpSecurity: "ssl" }, secret.ciphertext, secret.iv, secret.tag, secret.keyVersion],
    );
    await pool.query(`insert into public.email_imap_state (workspace_id, last_success_at) values ($1, now())`, [ws]);
    return ws;
  }

  // emailOnly (E3b-1): no phone, so email is the only usable channel and repeated AI emails aren't switched to WhatsApp.
  async function lead(ws: string, opts: { marked?: boolean; emailOnly?: boolean } = {}) {
    const phone = opts.emailOnly ? null : randomPhone();
    const result = await pool.query<{ id: string; email: string }>(
      `insert into public.leads (workspace_id, first_name, last_name, company, source, email, phone, phone_e164, owner_id, agent_status, agent_live_test, pipeline_stage)
       values ($1, 'Asha', 'Rao', 'Acme Steel', 'linkedin', $2, $3, $3, $4, 'active', $5, 'connected_qualifying') returning id, email`,
      [ws, `live-${randomUUID()}@example.com`, phone, adminId, opts.marked ?? true],
    );
    return { ...result.rows[0]!, phone };
  }

  async function wakeup(ws: string, leadId: string) {
    await pool.query(`insert into public.agent_wakeups (workspace_id, lead_id, due_at, reason) values ($1, $2, now() - interval '1 minute', 'enrolled')`, [ws, leadId]);
  }

  async function tick(ws: string, decisions: AgentDecision[]) {
    const { runAgentTick } = await import("../../src/services/agentRunner.service.js");
    const outcomes = await runAgentTick(true, { model: createFakeDecisionModel({ decisions }), embedder: fakeEmbedder, prices: PRICES, defaultModels: MODELS, workspaceIds: [ws] });
    // Send times come from the local clock, the claims compare with the database clock, which can lag by a second or two.
    await pool.query(`update public.agent_decisions set send_next_at = now() where workspace_id = $1 and send_status = 'queued' and send_next_at < now() + interval '10 seconds'`, [ws]);
    await pool.query(`update public.email_outbound_messages set next_attempt_at = now() where workspace_id = $1 and status = 'queued' and next_attempt_at < now() + interval '10 seconds'`, [ws]);
    return outcomes;
  }

  function fakeSocket() {
    return {
      user: { id: "919999999999:1@s.whatsapp.net" },
      fetchAccountReachoutTimelock: vi.fn(async () => null),
      fetchNewChatMessageCap: vi.fn(async () => null),
      onWhatsApp: vi.fn(async (number: string) => [{ exists: true, jid: `${number}@s.whatsapp.net` }]),
      sendMessage: vi.fn(async (_jid: string, content: { text?: string }) => ({ message: { conversation: content.text ?? "" } })),
      sendPresenceUpdate: vi.fn(async (_type: string, _jid?: string) => undefined),
    };
  }

  function whatsapp(ws: string) {
    const socket = fakeSocket();
    const m = new Manager(ws, async () => undefined);
    Object.assign(m as unknown as Record<string, unknown>, { socket, connected: true });
    const send: WhatsAppSender = (_ws, input) => m.sendAction({ source: input.source, phoneE164: input.to, body: input.body });
    return { socket, send };
  }

  async function sendTick(ws: string, send: WhatsAppSender, dryRun = false) {
    const { runAgentSends } = await import("../../src/services/agentSends.service.js");
    return runAgentSends(true, { workspaceIds: [ws], send, dryRun });
  }

  function fakeSmtp() {
    const sent: { from: unknown; subject?: string; messageId?: string; text?: string; inReplyTo?: string; references?: string | string[] }[] = [];
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const transport: EmailTransport = {
      async sendMail(mail) {
        const info = await builder.sendMail(mail);
        sent.push({ from: mail.from, subject: mail.subject, messageId: mail.messageId, text: mail.text as string, inReplyTo: mail.inReplyTo as string | undefined, references: mail.references as string | undefined });
        return { messageId: info.messageId, response: "250 OK" };
      },
      verify: async () => true,
      close: () => undefined,
    };
    return { sent, cache: new TransportCache(() => transport) };
  }

  async function emailTick(ws: string, smtp: ReturnType<typeof fakeSmtp>, dryRun = false) {
    const { runEmailOutbound } = await import("../../src/services/emailOutbound.service.js");
    return runEmailOutbound({ workspaceIds: [ws], transports: smtp.cache, wait: async () => undefined, dryRun });
  }

  /** A live, queued AI send written directly (for the re-check scenarios). */
  async function queued(ws: string, l: { id: string; email: string }, channel: "whatsapp" | "email", createdAgo = "0 minutes") {
    const id = (
      await pool.query<{ id: string }>(
        `insert into public.agent_decisions (workspace_id, lead_id, mode, action, reasoning, message_subject, message_body, outcome, send_status, send_next_at, created_at)
         values ($1, $2, 'live', $3, 'r', $4, 'Hi Asha, quick follow-up from our call.', 'executed', 'queued', now(), now() - $5::interval) returning id`,
        [ws, l.id, channel === "email" ? "send_email" : "send_whatsapp", channel === "email" ? "Follow-up" : null, createdAgo],
      )
    ).rows[0]!.id;
    if (channel === "email") {
      const { enqueueEmail } = await import("../../src/services/emailOutbound.service.js");
      await enqueueEmail(pool, { workspaceId: ws, source: "agent", sourceId: id, leadId: l.id, to: l.email, subject: "Follow-up", html: "<p>Hi Asha</p>" });
    }
    return id;
  }

  const decision = async (id: string) => (await pool.query(`select * from public.agent_decisions where id = $1`, [id])).rows[0];
  const decisionsOf = async (leadId: string) => (await pool.query(`select * from public.agent_decisions where lead_id = $1 order by created_at`, [leadId])).rows;
  const leadRow = async (id: string) => (await pool.query(`select * from public.leads where id = $1`, [id])).rows[0];
  const aiTimeline = async (leadId: string) => (await pool.query<{ title: string }>(`select title from public.timeline_events where lead_id = $1 and title like 'AI %' order by occurred_at, created_at`, [leadId])).rows.map((r) => r.title);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    ({ BaileysManager: Manager } = await import("../../src/providers/baileys.manager.js"));
    ({ TransportCache } = await import("../../src/providers/email.provider.js"));
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`live-admin-${randomUUID()}@example.com`]);
    adminId = auth.rows[0].id;
    await pool.query(`update public.profiles set role = 'admin', is_active = true, full_name = 'Govinda Rep' where id = $1`, [adminId]);
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await pool.query(`delete from auth.users where id = $1`, [adminId]).catch((error: Error) => console.warn(`[agentLive] user cleanup failed: ${error.message}`));
    await pool.end();
  });

  it("scope test_contacts: the marked contact gets a real WhatsApp (typing, opt-out once); an unmarked one only a draft", async () => {
    const ws = await workspace("scope");
    const marked = await lead(ws);
    const unmarked = await lead(ws, { marked: false });
    await wakeup(ws, marked.id);
    await wakeup(ws, unmarked.id);
    const outcomes = await tick(ws, [WHATSAPP]);
    expect(outcomes.map((o) => [o.leadId, o.result]).sort()).toEqual([[marked.id, "executed"], [unmarked.id, "draft"]].sort());

    const [shadowRow] = await decisionsOf(unmarked.id);
    expect(shadowRow).toMatchObject({ mode: "shadow", outcome: "draft", send_status: null });
    const [liveRow] = await decisionsOf(marked.id);
    expect(liveRow).toMatchObject({ mode: "live", outcome: "executed", send_status: "queued" });

    const { socket, send } = whatsapp(ws);
    expect(await sendTick(ws, send)).toEqual([{ id: liveRow.id, result: "sent" }]);
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    const text = socket.sendMessage.mock.calls[0]![1].text!;
    expect(text).toContain("— Govinda Rep, MOTM Technologies");
    expect(text.match(/Reply STOP to opt out\./g)).toHaveLength(1);
    expect(socket.sendPresenceUpdate.mock.calls.map((c) => c[0])).toContain("composing");

    const sent = await decision(liveRow.id);
    expect(sent).toMatchObject({ send_status: "sent", outcome: "sent" });
    expect(sent.sent_at).not.toBeNull();
    const outbound = (await pool.query(`select message_id, status from public.whatsapp_outbound_messages where agent_decision_id = $1`, [liveRow.id])).rows[0];
    expect(outbound).toMatchObject({ status: "sent", message_id: sent.provider_message_id });
    expect(await leadRow(marked.id)).toMatchObject({ agent_touch_count: 1 });
    expect(await aiTimeline(marked.id)).toEqual(["AI sent WhatsApp"]);
    expect((await leadRow(unmarked.id)).agent_touch_count).toBe(0);
    expect(await aiTimeline(unmarked.id)).toEqual(["AI drafted WhatsApp message"]);
  });

  it("WhatsApp goes through decideSend: outside the WhatsApp window → deferred (no attempt); a link in a first message → failed with the E1 reason", async () => {
    const ws = await workspace("decide");
    const today = (await pool.query<{ d: number }>(`select extract(isodow from now() at time zone 'Asia/Kolkata')::int as d`)).rows[0]!.d;
    await pool.query(`update public.whatsapp_connection set send_window_days = $2 where workspace_id = $1`, [ws, [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today)]);
    const l = await lead(ws);
    const id = await queued(ws, l, "whatsapp");
    const { socket, send } = whatsapp(ws);
    expect(await sendTick(ws, send)).toEqual([{ id, result: "deferred" }]);
    const deferred = await decision(id);
    expect(deferred).toMatchObject({ send_status: "queued", send_attempts: 0, send_error: "Outside the WhatsApp send window." });
    expect(deferred.send_next_at.getTime()).toBeGreaterThan(Date.now());
    expect(socket.sendMessage).not.toHaveBeenCalled();

    await pool.query(`update public.whatsapp_connection set send_window_days = '{1,2,3,4,5,6,7}' where workspace_id = $1`, [ws]);
    const linked = await lead(ws);
    const linkId = await queued(ws, linked, "whatsapp");
    await pool.query(`update public.agent_decisions set message_body = 'See acme.in/offer for details.' where id = $1`, [linkId]);
    await pool.query(`update public.agent_decisions set send_next_at = now() + interval '1 day' where id = $1`, [id]);
    expect(await sendTick(ws, send)).toEqual([{ id: linkId, result: "failed" }]);
    expect(await decision(linkId)).toMatchObject({ send_status: "failed", send_error: "First WhatsApp message can't contain a link" });
    const note = (await pool.query(`select title, recipient_id from public.notifications where lead_id = $1`, [linked.id])).rows;
    expect(note).toEqual([{ title: "AI message to Asha Rao failed", recipient_id: adminId }]);
  });

  it("email goes through email_outbound_messages: one agent row per decision, From owner | company, its Message-ID on the decision", async () => {
    const ws = await workspace("email");
    const l = await lead(ws, { emailOnly: true });
    await wakeup(ws, l.id);
    expect((await tick(ws, [EMAIL]))[0]).toMatchObject({ result: "executed", action: "send_email" });
    const [row] = await decisionsOf(l.id);
    const rows = (await pool.query(`select * from public.email_outbound_messages where source = 'agent' and source_id = $1`, [row.id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from_name: "Govinda Rep | MOTM Technologies", to_address: l.email, subject: "Outbound for Acme Steel", status: "queued", to_contact: true });

    const smtp = fakeSmtp();
    await emailTick(ws, smtp);
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]!.text).toContain("Best regards,\nGovinda Rep\nMOTM Technologies");
    const sent = await decision(row.id);
    expect(sent).toMatchObject({ send_status: "sent", outcome: "sent", provider_message_id: smtp.sent[0]!.messageId });
    // D3 matches replies by this Message-ID on the outbound row.
    const outbound = (await pool.query(`select message_id from public.email_outbound_messages where id = $1`, [rows[0].id])).rows[0];
    expect(outbound.message_id).toBe(sent.provider_message_id);
    expect(await aiTimeline(l.id)).toEqual(["AI sent email: Outbound for Acme Steel"]);
    expect((await leadRow(l.id)).agent_touch_count).toBe(1);
  });

  describe("E3a: email threading", () => {
    /** Sends one AI email through the runner and queue; `gap` clears the time and touch limits for the next one. */
    async function sendAiEmail(ws: string, l: { id: string }, smtp: ReturnType<typeof fakeSmtp>, answer: AgentDecision) {
      await wakeup(ws, l.id);
      expect((await tick(ws, [answer]))[0]).toMatchObject({ result: "executed", action: "send_email" });
      expect(await emailTick(ws, smtp)).toEqual(["sent"]);
      await pool.query(`update public.email_outbound_messages set sent_at = sent_at - interval '10 days' where lead_id = $1`, [l.id]);
      await pool.query(`update public.agent_decisions set sent_at = sent_at - interval '10 days', created_at = created_at - interval '10 days' where lead_id = $1`, [l.id]);
      await pool.query(`update public.leads set agent_touch_count = 0, agent_last_touch_at = null where id = $1`, [l.id]);
      await pool.query(`update public.agent_wakeups set status = 'done' where lead_id = $1 and status = 'pending'`, [l.id]);
      await pool.query(`update public.integration_connections set next_send_at = null where workspace_id = $1 and id = 'email'`, [ws]);
    }
    const FOLLOW_UP: AgentDecision = { ...EMAIL, subject: "-", body: "Hi Asha,\n\nOne more thought on your outbound plan. Would Thursday suit you?" } as AgentDecision;

    it("the second AI email continues the first's thread, with a new Message-ID; the first has no thread headers; a reply still matches", async () => {
      const ws = await workspace("thread");
      const l = await lead(ws, { emailOnly: true });
      const smtp = fakeSmtp();
      await sendAiEmail(ws, l, smtp, EMAIL);
      await sendAiEmail(ws, l, smtp, FOLLOW_UP);
      const [first, second] = smtp.sent;
      expect(first).toMatchObject({ subject: "Outbound for Acme Steel" });
      expect(first!.inReplyTo).toBeUndefined();
      expect(first!.references).toBeUndefined();
      expect(second).toMatchObject({ subject: "Re: Outbound for Acme Steel", inReplyTo: first!.messageId, references: first!.messageId });
      expect(second!.messageId).not.toBe(first!.messageId);
      const stored = (await decisionsOf(l.id)).filter((d) => d.action === "send_email").map((d) => d.message_subject);
      expect(stored).toEqual(["Outbound for Acme Steel", "Re: Outbound for Acme Steel"]);

      // A third stays "Re: <first subject>", answering the second.
      await sendAiEmail(ws, l, smtp, FOLLOW_UP);
      expect(smtp.sent[2]).toMatchObject({ subject: "Re: Outbound for Acme Steel", inReplyTo: second!.messageId });
      // The Message-ID D3 matches a reply on (emailInbound.test.ts) is stored per email.
      const { rows } = await pool.query<{ message_id: string }>(`select message_id from public.email_outbound_messages where lead_id = $1 order by sent_at`, [l.id]);
      expect(new Set(rows.map((r) => r.message_id)).size).toBe(3);
    });

    it("older than 45 days, or bounced: a new thread with the model's subject", async () => {
      const ws = await workspace("thread-old");
      const old = await lead(ws, { emailOnly: true });
      const bounced = await lead(ws, { emailOnly: true });
      const smtp = fakeSmtp();
      await sendAiEmail(ws, old, smtp, EMAIL);
      await sendAiEmail(ws, bounced, smtp, EMAIL);
      await pool.query(`update public.email_outbound_messages set sent_at = now() - interval '46 days' where lead_id = $1`, [old.id]);
      await pool.query(`update public.email_outbound_messages set bounced_at = now() where lead_id = $1`, [bounced.id]);
      const NEW: AgentDecision = { ...EMAIL, subject: "Next steps for Acme Steel" } as AgentDecision;
      await sendAiEmail(ws, old, smtp, NEW);
      await sendAiEmail(ws, bounced, smtp, NEW);
      for (const mail of smtp.sent.slice(2)) {
        expect(mail.subject).toBe("Next steps for Acme Steel");
        expect(mail.inReplyTo).toBeUndefined();
      }
    });

    it("a queued follow-up whose earlier email bounced before it went starts a new thread with the plain subject", async () => {
      const ws = await workspace("thread-race");
      const l = await lead(ws, { emailOnly: true });
      const smtp = fakeSmtp();
      await sendAiEmail(ws, l, smtp, EMAIL);
      await wakeup(ws, l.id);
      await tick(ws, [FOLLOW_UP]);
      await pool.query(`update public.email_outbound_messages set bounced_at = now() where lead_id = $1 and status = 'sent'`, [l.id]);
      expect(await emailTick(ws, smtp)).toEqual(["sent"]);
      expect(smtp.sent[1]).toMatchObject({ subject: "Outbound for Acme Steel" });
      expect(smtp.sent[1]!.inReplyTo).toBeUndefined();
    });

    it("rep proposal and meeting emails are never threaded", async () => {
      const ws = await workspace("thread-rep");
      const l = await lead(ws, { emailOnly: true });
      const smtp = fakeSmtp();
      await sendAiEmail(ws, l, smtp, EMAIL);
      const { enqueueEmail } = await import("../../src/services/emailOutbound.service.js");
      await enqueueEmail(pool, { workspaceId: ws, source: "test", sourceId: randomUUID(), to: "rep@example.com", subject: "Plain", html: "<p>Hi</p>" });
      expect(await emailTick(ws, smtp)).toEqual(["sent"]);
      expect(smtp.sent[1]).toMatchObject({ subject: "Plain" });
      expect(smtp.sent[1]!.inReplyTo).toBeUndefined();
    });
  });

  it("an AI email is automated: outside the email send window it waits (no attempt)", async () => {
    const ws = await workspace("email-window");
    const today = (await pool.query<{ d: number }>(`select extract(isodow from now() at time zone 'Asia/Kolkata')::int as d`)).rows[0]!.d;
    await pool.query(`update public.integration_connections set send_window_days = $2 where workspace_id = $1 and id = 'email'`, [ws, [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today)]);
    const l = await lead(ws);
    const id = await queued(ws, l, "email");
    const smtp = fakeSmtp();
    await emailTick(ws, smtp);
    expect(smtp.sent).toHaveLength(0);
    const row = (await pool.query(`select status, attempts, next_attempt_at from public.email_outbound_messages where source_id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ status: "queued", attempts: 0 });
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    expect((await decision(id)).send_status).toBe("queued");
  });

  describe("the send-time re-check cancels", () => {
    let ws: string;
    let wa: ReturnType<typeof whatsapp>;
    beforeAll(async () => {
      ws = await workspace("recheck");
      wa = whatsapp(ws);
    });

    async function expectWhatsAppCancelled(setup: (l: Awaited<ReturnType<typeof lead>>, id: string) => Promise<void>, reason: RegExp, createdAgo?: string) {
      const l = await lead(ws);
      const id = await queued(ws, l, "whatsapp", createdAgo);
      await setup(l, id);
      const calls = wa.socket.sendMessage.mock.calls.length;
      await sendTick(ws, wa.send);
      const row = await decision(id);
      expect(row.send_status).toBe("cancelled");
      expect(row.cancel_reason).toMatch(reason);
      expect(wa.socket.sendMessage.mock.calls.length).toBe(calls);
    }

    async function expectEmailCancelled(setup: (l: Awaited<ReturnType<typeof lead>>) => Promise<void>, reason: RegExp) {
      const l = await lead(ws);
      const id = await queued(ws, l, "email");
      await setup(l);
      const smtp = fakeSmtp();
      await emailTick(ws, smtp);
      expect(smtp.sent).toHaveLength(0);
      const row = await decision(id);
      expect(row.send_status).toBe("cancelled");
      expect(row.cancel_reason).toMatch(reason);
      expect((await pool.query(`select status from public.email_outbound_messages where source_id = $1`, [id])).rows[0].status).toBe("cancelled");
    }

    it("a WhatsApp reply after the decision", () =>
      expectWhatsAppCancelled(async (l) => {
        await pool.query(
          `insert into public.whatsapp_inbound_events (message_id, sender_jid, sender_phone_e164, message_type, received_at, disposition, match_count, workspace_id, lead_id)
           values ($1, $2, $3, 'conversation', now(), 'matched', 1, $4, $5)`,
          [`IN-${randomUUID()}`, `${l.phone!.slice(1)}@s.whatsapp.net`, l.phone, ws, l.id],
        );
      }, /replied after/));

    it("an email reply after the decision (WhatsApp send)", () =>
      expectWhatsAppCancelled(async (l) => {
        await pool.query(
          `insert into public.email_inbound_events (workspace_id, uidvalidity, uid, received_at, kind, match_status, lead_id)
           values ($1, 1, (random() * 1e9)::bigint, now(), 'reply', 'matched', $2)`,
          [ws, l.id],
        );
      }, /replied after/));

    it("an email reply after the decision (email send)", () =>
      expectEmailCancelled(async (l) => {
        await pool.query(
          `insert into public.email_inbound_events (workspace_id, uidvalidity, uid, received_at, kind, match_status, lead_id)
           values ($1, 1, (random() * 1e9)::bigint, now(), 'reply', 'matched', $2)`,
          [ws, l.id],
        );
      }, /replied after/));

    it("email bounced or unsubscribed", async () => {
      for (const status of ["permanent_bounce", "unsubscribed"]) {
        await expectEmailCancelled(async (l) => {
          await pool.query(`insert into public.lead_contact_channels (lead_id, channel, status, updated_by_name) values ($1, 'email', $2, 'Test')`, [l.id, status]);
        }, /email can't be used/);
      }
    });

    it("IMAP unhealthy (email only)", async () => {
      await pool.query(`update public.email_imap_state set last_success_at = now() - interval '2 hours' where workspace_id = $1`, [ws]);
      try {
        await expectEmailCancelled(async () => undefined, /reply reading/);
      } finally {
        await pool.query(`update public.email_imap_state set last_success_at = now() where workspace_id = $1`, [ws]);
      }
    });

    it("Do Not Contact", () =>
      expectWhatsAppCancelled(async (l) => {
        await pool.query(`update public.leads set lifecycle_state = 'do_not_contact', dnc_reason = 'Asked not to be contacted' where id = $1`, [l.id]);
      }, /Do Not Contact|stopped/));

    it("opted out of WhatsApp", () =>
      expectWhatsAppCancelled(async (l) => {
        await pool.query(`insert into public.lead_contact_channels (lead_id, channel, status, updated_by_name) values ($1, 'whatsapp', 'opted_out', 'Test')`, [l.id]);
      }, /WhatsApp can't be used/));

    it("test mark removed", () =>
      expectWhatsAppCancelled(async (l) => {
        await pool.query(`update public.leads set agent_live_test = false where id = $1`, [l.id]);
      }, /no longer live/));

    it("AI paused for the contact", () =>
      expectWhatsAppCancelled(async (l) => {
        await pool.query(`update public.leads set agent_status = 'paused' where id = $1`, [l.id]);
      }, /paused/));

    it("an active workflow run", () =>
      expectWhatsAppCancelled(async (l) => {
        const workflow = await pool.query<{ id: string }>(
          `insert into public.workflows (workspace_id, name, trigger, status) values ($1, $2, 'manual_enrollment', 'active') returning id`,
          [ws, `E2 ${randomUUID()}`],
        );
        const version = await pool.query<{ id: string }>(
          `insert into public.workflow_versions (workflow_id, version_number, status, published_at) values ($1, 1, 'published', now()) returning id`,
          [workflow.rows[0]!.id],
        );
        await pool.query(`insert into public.workflow_runs (workspace_id, workflow_id, workflow_version_id, lead_id, status) values ($1, $2, $3, $4, 'waiting')`, [
          ws,
          workflow.rows[0]!.id,
          version.rows[0]!.id,
          l.id,
        ]);
      }, /active workflow/));

    it("older than 24 h", () => expectWhatsAppCancelled(async () => undefined, /24 hours/, "25 hours"));

    it("the workspace switched to shadow (kill switch)", async () => {
      const l = await lead(ws);
      const id = await queued(ws, l, "whatsapp");
      await pool.query(`update public.agent_settings set mode = 'shadow' where workspace_id = $1`, [ws]);
      try {
        await sendTick(ws, wa.send);
      } finally {
        await pool.query(`update public.agent_settings set mode = 'live' where workspace_id = $1`, [ws]);
      }
      expect(await decision(id)).toMatchObject({ send_status: "cancelled" });
      expect((await decision(id)).cancel_reason).toMatch(/no longer live/);
    });
  });

  it("dry run: no provider call, marked dry_run, no touch", async () => {
    const ws = await workspace("dry");
    const l = await lead(ws);
    const waId = await queued(ws, l, "whatsapp");
    const emailId = await queued(ws, l, "email");
    const { socket, send } = whatsapp(ws);
    expect(await sendTick(ws, send, true)).toEqual([{ id: waId, result: "dry_run" }]);
    const smtp = fakeSmtp();
    await emailTick(ws, smtp, true);
    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(smtp.sent).toHaveLength(0);
    expect(await decision(waId)).toMatchObject({ send_status: "dry_run", outcome: "executed", sent_at: null });
    expect(await decision(emailId)).toMatchObject({ send_status: "dry_run", outcome: "executed" });
    expect(await leadRow(l.id)).toMatchObject({ agent_touch_count: 0, agent_last_touch_at: null });
  });

  it("the same decision claimed twice sends once", async () => {
    const ws = await workspace("twice");
    const l = await lead(ws);
    const id = await queued(ws, l, "whatsapp");
    const { socket, send } = whatsapp(ws);
    const [a, b] = await Promise.all([sendTick(ws, send), sendTick(ws, send)]);
    expect([...a, ...b]).toEqual([{ id, result: "sent" }]);
    // A crash after the send but before marking it: the reclaimed row finds the sent WhatsApp and doesn't send again.
    await pool.query(`update public.agent_decisions set send_status = 'sending', outcome = 'executed', sent_at = null, send_next_at = now() - interval '1 minute' where id = $1`, [id]);
    expect(await sendTick(ws, send)).toEqual([{ id, result: "sent" }]);
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("handoff creates exactly one open task for the owner; a second handoff doesn't duplicate it", async () => {
    const ws = await workspace("handoff");
    const l = await lead(ws);
    const handoff: AgentDecision = { action: "handoff", title: "Asked about pricing", urgency: "normal", reasoning: "Needs a rep." };
    await wakeup(ws, l.id);
    expect((await tick(ws, [handoff]))[0]).toMatchObject({ result: "executed", action: "handoff" });
    expect(await leadRow(l.id)).toMatchObject({ agent_status: "handed_off", agent_status_reason: "ai_handoff" });
    await pool.query(`update public.leads set agent_status = 'active' where id = $1`, [l.id]);
    await wakeup(ws, l.id);
    await tick(ws, [handoff]);
    const tasks = (await pool.query(`select title, owner_id, origin, task_type from public.tasks where lead_id = $1 and status = 'open'`, [l.id])).rows;
    expect(tasks).toEqual([{ title: "AI handed off — please follow up", owner_id: adminId, origin: "agent", task_type: "follow_up" }]);
    expect((await aiTimeline(l.id)).filter((t) => t.startsWith("AI handed off"))).toEqual(["AI handed off: Asked about pricing", "AI handed off: Asked about pricing"]);
  });

  it("stop and update_stage are executed for a live contact", async () => {
    const ws = await workspace("actions");
    const staged = await lead(ws);
    await wakeup(ws, staged.id);
    await tick(ws, [{ action: "update_stage", newStage: "interested_later", reasoning: "Said next quarter." }]);
    expect((await leadRow(staged.id)).pipeline_stage).toBe("interested_later");
    expect(await aiTimeline(staged.id)).toEqual(["AI moved stage to interested later"]);
    expect((await pool.query(`select 1 from public.agent_wakeups where lead_id = $1 and status = 'pending'`, [staged.id])).rowCount).toBe(1);

    const stopped = await lead(ws);
    await wakeup(ws, stopped.id);
    await tick(ws, [{ action: "stop", reason: "not_a_fit", moveToLongTermNurture: false, reasoning: "Wrong market." }]);
    expect(await leadRow(stopped.id)).toMatchObject({ agent_status: "stopped", agent_status_reason: "not_a_fit" });
    expect(await aiTimeline(stopped.id)).toEqual(["AI stopped"]);
  });

  it("only real sends count: shadow drafts don't hold back a live contact's next message", async () => {
    const ws = await workspace("touches");
    const l = await lead(ws);
    await pool.query(
      `insert into public.agent_decisions (workspace_id, lead_id, mode, action, reasoning, message_body, send_at, rules_result, outcome, created_at)
       values ($1, $2, 'shadow', 'send_whatsapp', 'r', 'Draft', now() - interval '1 hour', '{"allowed": true}', 'draft', now() - interval '1 hour'),
              ($1, $2, 'shadow', 'send_whatsapp', 'r', 'Draft', now() - interval '2 hours', '{"allowed": true}', 'draft', now() - interval '2 hours')`,
      [ws, l.id],
    );
    await wakeup(ws, l.id);
    await tick(ws, [WHATSAPP]);
    const live = (await decisionsOf(l.id)).at(-1);
    expect(live).toMatchObject({ mode: "live", send_status: "queued" });
    expect(live.send_next_at.getTime()).toBeLessThan(Date.now() + 60_000);
  });
});
