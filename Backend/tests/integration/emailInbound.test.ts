/**
 * D3: the worker reads the workspace mailbox over IMAP (a fake client serving raw RFC 822
 * fixtures; never a real server) and applies bounce / auto-reply / unsubscribe / reply effects.
 * The AI label step uses the fake model (never OpenAI). Nothing is sent. Skipped unless
 * TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import { autoReply, dsn, plainReply, unsubscribeMessage } from "../fixtures/email/rawEmails.js";
import type { ReplyClassification } from "../../src/agent/replyClassification.js";
import type { ImapMessage, ImapReader } from "../../src/providers/email.provider.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const OWN = "crm@motm.example";
const PRICES = { "m-ground": { inputPer1M: 1, outputPer1M: 4 } };
const MODELS = { decision: "m-decide", grounding: "m-ground" };
const READ_ONLY_CALLS = new Set(["connect", "mailboxOpen", "search", "fetch", "logout", "close"]);

/** A fake mailbox: read-only calls are recorded, anything else (flags, move, delete…) is recorded as forbidden and throws. */
function fakeMailbox() {
  const calls: string[] = [];
  const fetchQueries: unknown[] = [];
  let uidValidity = 1;
  let nextUid = 1;
  let messages: Required<ImapMessage>[] = [];
  let loginError: Error | null = null;
  const client = {
    async connect() {
      calls.push("connect");
      if (loginError) throw loginError;
    },
    async mailboxOpen(path: string, options: { readOnly: true }) {
      calls.push(`mailboxOpen:${path}:${options.readOnly}`);
      return { uidValidity: BigInt(uidValidity), uidNext: nextUid };
    },
    async search(query: { since?: Date; uid?: string }) {
      calls.push("search");
      if (query.since) {
        const day = new Date(query.since);
        day.setUTCHours(0, 0, 0, 0);
        return messages.filter((m) => (m.internalDate as Date) >= day).map((m) => m.uid);
      }
      const from = Number(query.uid!.split(":")[0]);
      const found = messages.filter((m) => m.uid >= from).map((m) => m.uid);
      // IMAP: "n:*" always includes the newest message.
      return found.length || !messages.length ? found : [messages[messages.length - 1]!.uid];
    },
    async *fetch(range: string, query: { source?: unknown }) {
      calls.push("fetch");
      fetchQueries.push(query);
      const wanted = new Set(range.split(",").map(Number));
      for (const m of messages) if (wanted.has(m.uid)) yield { uid: m.uid, internalDate: m.internalDate, ...(query.source ? { source: m.source } : {}) };
    },
    async logout() {
      calls.push("logout");
    },
    close() {
      calls.push("close");
    },
  };
  const proxy = new Proxy(client, {
    get(target, prop: string) {
      if (READ_ONLY_CALLS.has(prop)) return target[prop as keyof typeof target];
      if (prop === "then") return undefined;
      calls.push(`FORBIDDEN:${prop}`);
      return () => {
        throw new Error(`forbidden IMAP call ${prop}`);
      };
    },
  }) as unknown as ImapReader;
  return {
    calls,
    fetchQueries,
    factory: () => proxy,
    add(raw: string, internalDate = new Date()) {
      messages.push({ uid: nextUid, internalDate, source: Buffer.from(raw) });
      return nextUid++;
    },
    /** A new UIDVALIDITY: the server renumbered everything. */
    renumber() {
      uidValidity += 1;
      nextUid = 1;
      messages = messages.map((m) => ({ ...m, uid: nextUid++ }));
    },
    failLogin(error: Error | null) {
      loginError = error;
    },
  };
}

describeIfDb("D3 email replies, bounces and unsubscribes over IMAP (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let owner: Actor;
  let admin: Actor;
  let otherRep: Actor;
  const boxes: ReturnType<typeof fakeMailbox>[] = [];
  const logged: string[] = [];
  const secrets: string[] = [];
  const secret = (text: string) => {
    const marker = `${text} [d3-${randomUUID().slice(0, 8)}]`;
    secrets.push(marker);
    return marker;
  };

  /** An SMTP + IMAP workspace whose login was saved an hour ago. */
  async function workspace(label: string, mode: "off" | "shadow" = "shadow") {
    const ws = await createTestWorkspace(pool, `d3-${label}`);
    const { encryptJson } = await import("../../src/security/encryption.js");
    const s = encryptJson({ smtpUsername: OWN, smtpPassword: "app-password" }, "integration:email");
    await pool.query(
      `insert into public.integration_connections
         (workspace_id, id, provider, enabled, settings, secret_ciphertext, secret_iv, secret_tag, key_version, configured_at)
       values ($1, 'email', 'smtp', true, $2, $3, $4, $5, $6, now() - interval '1 hour')`,
      [
        ws,
        { senderName: "MOTM", senderAddress: OWN, smtpHost: "smtp.motm.example", smtpPort: 465, smtpSecurity: "ssl", imapHost: "imap.motm.example", imapPort: 993, imapSecurity: "ssl", imapSameLogin: true, imapFolder: "INBOX" },
        s.ciphertext,
        s.iv,
        s.tag,
        s.keyVersion,
      ],
    );
    await pool.query(`update public.agent_settings set mode = $2, monthly_budget_usd = 100 where workspace_id = $1`, [ws, mode]);
    const box = fakeMailbox();
    boxes.push(box);
    return { ws, box };
  }

  async function contact(ws: string, opts: { email?: string; agentStatus?: string } = {}) {
    const email = opts.email ?? `ravi-${randomUUID().slice(0, 8)}@example.com`;
    const row = await pool.query<{ id: string }>(
      `insert into public.leads (workspace_id, first_name, last_name, company, source, email, owner_id, agent_status, pipeline_stage)
       values ($1, 'Ravi', 'Kumar', 'Client Co', 'referral', $2, $3, $4, 'connected_qualifying') returning id`,
      [ws, email, owner.id, opts.agentStatus ?? "active"],
    );
    return { id: row.rows[0]!.id, email };
  }

  /** One of our sent emails to the contact, with the Message-ID a reply would quote. */
  async function sentEmail(ws: string, leadId: string, to: string) {
    const messageId = `<${randomUUID()}@motm.example>`;
    const row = await pool.query<{ id: string }>(
      `insert into public.email_outbound_messages (workspace_id, source, source_id, lead_id, to_address, to_contact, subject, html, text_body, status, sent_at, message_id)
       values ($1, 'test', gen_random_uuid(), $2, $3, true, 'Quick question', '<p>Hi</p>', 'Hi', 'sent', now(), $4) returning id`,
      [ws, leadId, to, messageId],
    );
    return { id: row.rows[0]!.id, messageId };
  }

  async function poll(ws: string, box: ReturnType<typeof fakeMailbox>) {
    const { runEmailInbound } = await import("../../src/services/emailInbound.service.js");
    await pool.query(`update public.email_imap_state set next_poll_at = now() where workspace_id = $1`, [ws]);
    return runEmailInbound({ imap: box.factory, workspaceIds: [ws] });
  }

  const events = async (ws: string) =>
    (await pool.query(`select * from public.email_inbound_events where workspace_id = $1 order by uid`, [ws])).rows;
  const state = async (ws: string) => (await pool.query(`select * from public.email_imap_state where workspace_id = $1`, [ws])).rows[0];
  const emailStatus = async (leadId: string) =>
    (await pool.query(`select status from public.lead_contact_channels where lead_id = $1 and channel = 'email'`, [leadId])).rows[0]?.status ?? null;
  const timeline = async (leadId: string) =>
    (await pool.query<{ title: string }>(`select title from public.timeline_events where lead_id = $1 order by occurred_at, id`, [leadId])).rows.map((r) => r.title);
  const leadRow = async (id: string) =>
    (await pool.query(`select agent_status, agent_status_reason, lifecycle_state, response_state, automation_mode from public.leads where id = $1`, [id])).rows[0];
  const tasks = async (id: string) => (await pool.query(`select title, status, origin from public.tasks where lead_id = $1 order by created_at`, [id])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "d3-email-inbound");
    owner = await api.newUser("salesperson", { name: "D3 Owner" });
    admin = await api.newUser("admin", { name: "D3 Admin" });
    otherRep = await api.newUser("salesperson", { name: "D3 Other" });
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    // Rule 1: nothing ever touched the mailbox beyond EXAMINE / SEARCH / FETCH (PEEK) / LOGOUT.
    const all = boxes.flatMap((b) => b.calls);
    expect(all.filter((c) => c.startsWith("FORBIDDEN"))).toEqual([]);
    expect(all.filter((c) => c.startsWith("mailboxOpen")).every((c) => c.endsWith(":true"))).toBe(true);
    // The reply text never reached a log line.
    for (const marker of secrets) expect(logged.some((line) => line.includes(marker))).toBe(false);
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("first poll reads only mail after the login was saved; 50 per poll; read-only; each message once", async () => {
    const { ws, box } = await workspace("first-poll");
    box.add(plainReply({ messageId: "<old@client.test>", from: "Old <old@client.test>" }), new Date(Date.now() - 3 * 86_400_000));
    box.add(plainReply({ messageId: "<older-today@client.test>", from: "Old <old@client.test>" }), new Date(Date.now() - 2 * 3_600_000));
    for (let i = 0; i < 55; i++) box.add(plainReply({ messageId: `<n${i}-${ws}@service.test>`, from: "Portal <no-reply@service.test>" }));

    const first = await poll(ws, box);
    expect(first).toMatchObject({ outcome: "polled", processed: 50, kinds: { ignored: 50 } });
    expect(Number((await state(ws)).last_uid)).toBe(52);
    const second = await poll(ws, box);
    expect(second).toMatchObject({ processed: 5 });
    const rows = await events(ws);
    expect(rows).toHaveLength(55);
    expect(rows.some((r) => r.message_id_header === "<old@client.test>" || r.message_id_header === "<older-today@client.test>")).toBe(false);
    expect(await state(ws)).toMatchObject({ uidvalidity: "1", last_uid: "57", last_error: null });
    expect((await state(ws)).last_success_at).not.toBeNull();
    // Nothing new: a poll reads nothing; the same message re-delivered under a new UID is processed once.
    expect(await poll(ws, box)).toMatchObject({ processed: 0 });
    box.add(plainReply({ messageId: `<n0-${ws}@service.test>`, from: "Portal <no-reply@service.test>" }));
    expect(await poll(ws, box)).toMatchObject({ processed: 1, kinds: { duplicate: 1 } });
    expect(await events(ws)).toHaveLength(55);
    // Sources are fetched with a byte cap (BODY.PEEK partial), never flagged.
    expect(box.fetchQueries.some((q) => JSON.stringify(q).includes("maxLength"))).toBe(true);
    expect(box.calls.filter((c) => c === "logout")).toHaveLength(box.calls.filter((c) => c === "connect").length);
  });

  it("a UIDVALIDITY change reads only mail after the last good poll", async () => {
    const { ws, box } = await workspace("uidvalidity");
    // Well before the poll (DB clock), so the renumbered copy is "history" too.
    box.add(plainReply({ messageId: "<a@service.test>", from: "no-reply@service.test" }), new Date(Date.now() - 30 * 60_000));
    await poll(ws, box);
    box.add(plainReply({ messageId: "<b-history@service.test>", from: "no-reply@service.test" }), new Date(Date.now() - 86_400_000));
    box.renumber();
    box.add(plainReply({ messageId: "<c-new@service.test>", from: "no-reply@service.test" }), new Date(Date.now() + 60_000));
    const result = await poll(ws, box);
    expect(result).toMatchObject({ processed: 1 });
    expect((await events(ws)).map((e) => e.message_id_header)).toEqual(["<a@service.test>", "<c-new@service.test>"]);
    expect(await state(ws)).toMatchObject({ uidvalidity: "2", last_uid: "3" });
  });

  it("an IMAP login rejection is recorded and admins are told once a day; sending is not paused", async () => {
    const { ws, box } = await workspace("login");
    box.failLogin(Object.assign(new Error("Authentication failed."), { authenticationFailed: true }));
    expect(await poll(ws, box)).toMatchObject({ outcome: "error" });
    expect(await poll(ws, box)).toMatchObject({ outcome: "error" });
    expect((await state(ws)).last_error).toBe("IMAP login rejected — check the IMAP username and password in Settings → Email.");
    const n = await pool.query(`select count(*)::int as n from public.notifications where workspace_id = $1 and title = 'Email replies can''t be read'`, [ws]);
    const admins = (await pool.query(`select count(*)::int as n from public.profiles where role = 'admin' and is_active`)).rows[0].n;
    expect(n.rows[0].n).toBe(admins);
    expect((await pool.query(`select enabled from public.integration_connections where workspace_id = $1 and id = 'email'`, [ws])).rows[0].enabled).toBe(true);
    box.failLogin(null);
    expect(await poll(ws, box)).toMatchObject({ outcome: "polled" });
    expect((await state(ws)).last_error).toBeNull();
  });

  it("bounce 5.1.1: our email bounced, contact email invalid, timeline, and it counts toward the 5 % pause", async () => {
    const { ws, box } = await workspace("bounce");
    const c = await contact(ws);
    const ours = await sentEmail(ws, c.id, c.email);
    // 37 + ours = 38 sent, 1 earlier rejection + this bounce = 2 of 40 attempts (5 %).
    await pool.query(
      `insert into public.email_outbound_messages (workspace_id, source, source_id, to_address, subject, html, text_body, status, sent_at)
       select $1, 'test', gen_random_uuid(), 'filler@example.com', 'f', 'f', 'f', 'sent', now() from generate_series(1, 37)`,
      [ws],
    );
    await pool.query(`insert into public.email_safety_events (workspace_id, kind, detail) values ($1, 'recipient_rejected', 'earlier')`, [ws]);
    box.add(dsn({ status: "5.1.1", recipient: c.email, originalMessageId: ours.messageId }));
    expect(await poll(ws, box)).toMatchObject({ kinds: { bounce: 1 } });

    const [event] = await events(ws);
    expect(event).toMatchObject({ kind: "bounce", match_status: "matched", match_method: "original_message", lead_id: c.id, outbound_id: ours.id, bounce_status: "5.1.1", body_ciphertext: null });
    const outbound = (await pool.query(`select bounced_at, bounce_status from public.email_outbound_messages where id = $1`, [ours.id])).rows[0];
    expect(outbound.bounce_status).toBe("5.1.1");
    expect(outbound.bounced_at).not.toBeNull();
    expect(await emailStatus(c.id)).toBe("invalid");
    expect(await timeline(c.id)).toContain("Email bounced (address doesn't exist)");
    expect((await pool.query(`select enabled, paused_reason from public.integration_connections where workspace_id = $1 and id = 'email'`, [ws])).rows[0]).toMatchObject({
      enabled: false,
      paused_reason: "2 of 40 emails were rejected by the recipient's server in 24 hours.",
    });
  });

  it("a 4.x delayed DSN is recorded with no contact change; an unlinkable bounce is unmatched", async () => {
    const { ws, box } = await workspace("bounce-temp");
    const c = await contact(ws);
    const ours = await sentEmail(ws, c.id, c.email);
    box.add(dsn({ status: "4.4.7", action: "delayed", recipient: c.email, originalMessageId: ours.messageId, messageId: "<dsn-delay@mx.test>" }));
    box.add(dsn({ status: "5.1.1", recipient: "stranger@nowhere.test", originalMessageId: "<not-ours@x.test>", messageId: "<dsn-stranger@mx.test>" }));
    await poll(ws, box);
    const rows = await events(ws);
    expect(rows.map((r) => [r.kind, r.match_status])).toEqual([["bounce_temporary", "matched"], ["bounce", "unmatched"]]);
    expect(await emailStatus(c.id)).toBeNull();
    expect((await pool.query(`select bounced_at from public.email_outbound_messages where id = $1`, [ours.id])).rows[0].bounced_at).toBeNull();
    expect(await timeline(c.id)).toEqual([]);
  });

  it("out of office: timeline row only (no handoff, task, label or text)", async () => {
    const { ws, box } = await workspace("ooo");
    const c = await contact(ws);
    const ours = await sentEmail(ws, c.id, c.email);
    box.add(autoReply({ from: `Ravi <${c.email}>`, inReplyTo: ours.messageId }));
    await poll(ws, box);
    expect((await events(ws))[0]).toMatchObject({ kind: "auto_reply", match_status: "matched", match_method: "in_reply_to", body_ciphertext: null, reply_label: null });
    expect(await timeline(c.id)).toEqual(["Automatic email reply received (out of office or similar)"]);
    expect(await leadRow(c.id)).toMatchObject({ agent_status: "active" });
    expect(await tasks(c.id)).toEqual([]);
  });

  it("unsubscribe: email unsubscribed, AI stopped (asked_to_stop), owner notified, never DNC, no task", async () => {
    const { ws, box } = await workspace("unsub");
    const c = await contact(ws);
    box.add(unsubscribeMessage({ from: `Ravi <${c.email}>`, to: OWN }));
    await poll(ws, box);
    expect((await events(ws))[0]).toMatchObject({ kind: "unsubscribe", match_status: "matched", match_method: "sender" });
    expect(await emailStatus(c.id)).toBe("unsubscribed");
    expect(await leadRow(c.id)).toMatchObject({ agent_status: "stopped", agent_status_reason: "asked_to_stop", lifecycle_state: "active" });
    expect(await timeline(c.id)).toEqual(expect.arrayContaining(["Unsubscribed from email", "AI Agent Stopped"]));
    const notes = await pool.query(`select title, recipient_id from public.notifications where lead_id = $1`, [c.id]);
    expect(notes.rows).toEqual([{ title: "Ravi Kumar unsubscribed from email", recipient_id: owner.id }]);
    expect(await tasks(c.id)).toEqual([]);
  });

  it("E3a: a reply to a threaded AI follow-up matches that email, by In-Reply-To or only by References", async () => {
    const { ws, box } = await workspace("reply-thread");
    const c = await contact(ws);
    const first = await sentEmail(ws, c.id, c.email);
    const second = await sentEmail(ws, c.id, c.email);
    box.add(plainReply({ messageId: "<t1@client.test>", from: `Ravi <${c.email}>`, inReplyTo: second.messageId, references: `${first.messageId} ${second.messageId}`, subject: "Re: Quick question", text: secret("Thursday works") }));
    box.add(plainReply({ messageId: "<t2@client.test>", from: `Ravi <${c.email}>`, references: `${first.messageId} ${second.messageId}`, subject: "Re: Quick question", text: secret("Or Friday") }));
    await poll(ws, box);
    const rows = await events(ws);
    expect(rows[0]).toMatchObject({ kind: "reply", match_status: "matched", match_method: "in_reply_to", lead_id: c.id, outbound_id: second.id });
    expect(rows[1]).toMatchObject({ kind: "reply", match_status: "matched", match_method: "references", lead_id: c.id, outbound_id: second.id });
  });

  it("reply via In-Reply-To: encrypted, 'Replied by email', automation stopped, one task, handed off, labelled by the AI step; never shown as text", async () => {
    const { ws, box } = await workspace("reply");
    const c = await contact(ws);
    const ours = await sentEmail(ws, c.id, c.email);
    const text = secret("Yes please send the pricing");
    box.add(plainReply({ from: `Ravi <${c.email}>`, inReplyTo: ours.messageId, references: ours.messageId, text: `${text}\r\n\r\nOn Mon, Asha wrote:\r\n> Hi` }));
    await poll(ws, box);

    const [event] = await events(ws);
    expect(event).toMatchObject({ kind: "reply", match_status: "matched", match_method: "in_reply_to", lead_id: c.id, outbound_id: ours.id, classification_status: "pending" });
    expect(event.body_ciphertext).not.toBeNull();
    expect(Buffer.from(event.body_ciphertext).toString("utf8")).not.toContain("pricing");
    expect(await timeline(c.id)).toEqual(expect.arrayContaining(["Replied by email", "AI Agent Handed Off"]));
    expect(await leadRow(c.id)).toMatchObject({ agent_status: "handed_off", response_state: "responded", automation_mode: "manual" });
    expect(await tasks(c.id)).toEqual([{ title: "Lead replied by email — respond today", status: "open", origin: "agent" }]);

    // The worker's AI label step (fake model) sees the email text and labels it.
    const { runReplyClassification } = await import("../../src/services/replyClassifier.service.js");
    const model = createFakeDecisionModel({ replies: [{ label: "positive", confidence: 0.92 } as ReplyClassification], tokens: { input: 200, output: 8 } });
    const outcomes = await runReplyClassification(true, { model, prices: PRICES, defaultModels: MODELS, workspaceIds: [ws] });
    expect(outcomes).toEqual([{ messageId: event.id, result: "classified", label: "positive" }]);
    expect(JSON.stringify(model.calls)).toContain(text);
    expect(JSON.stringify(model.calls)).toContain("one email reply");
    expect((await events(ws))[0]).toMatchObject({ reply_label: "positive", reply_label_source: "ai", classification_status: "done" });
    expect(Number((await events(ws))[0].classification_cost_usd)).toBeGreaterThan(0);
    expect(await tasks(c.id)).toEqual([{ title: "Wants to talk — respond today", status: "open", origin: "agent" }]);

    // A second reply keeps one open reply task (across channels too).
    box.add(plainReply({ messageId: "<reply-2@client.test>", from: `Ravi <${c.email}>`, inReplyTo: ours.messageId, text: secret("Also, Thursday?") }));
    await poll(ws, box);
    expect(await tasks(c.id)).toHaveLength(1);

    // Never as text in the timeline, contact list, search or notifications.
    for (const path of [`/contacts/${c.id}/timeline`, `/contacts?q=Ravi`, `/search?q=pricing`, `/contacts/${c.id}`, `/notifications`]) {
      const res = await api.call(owner, ws, "GET", path);
      expect(res.status).toBe(200);
      for (const marker of secrets) expect(JSON.stringify(res.body)).not.toContain(marker);
    }
  });

  it("reply by sender only; a reply from an address shared by two contacts is ambiguous (metadata only)", async () => {
    const { ws, box } = await workspace("sender");
    const c = await contact(ws, { agentStatus: "none" });
    box.add(plainReply({ messageId: "<s1@client.test>", from: `Ravi <${c.email.toUpperCase()}>`, text: secret("Sender only") }));
    const shared = `shared-${randomUUID().slice(0, 6)}@example.com`;
    const a = await contact(ws, { email: shared });
    const b = await contact(ws, { email: shared });
    box.add(plainReply({ messageId: "<s2@client.test>", from: `Someone <${shared}>`, text: secret("Ambiguous") }));
    await poll(ws, box);
    const [one, two] = await events(ws);
    expect(one).toMatchObject({ kind: "reply", match_status: "matched", match_method: "sender", lead_id: c.id, reply_label: "unclassified", classification_status: "skipped" });
    expect(await tasks(c.id)).toEqual([]); // not an AI contact
    expect(two).toMatchObject({ kind: "reply", match_status: "ambiguous", lead_id: null, body_ciphertext: null });
    expect(await timeline(a.id)).toEqual([]);
    expect(await timeline(b.id)).toEqual([]);
    expect(await leadRow(a.id)).toMatchObject({ response_state: expect.not.stringMatching(/^responded$/) });
  });

  it("keyword 'please stop' by email: unsubscribed, AI stopped, task re-titled, no AI call; never DNC", async () => {
    const { ws, box } = await workspace("keyword");
    const c = await contact(ws);
    const ours = await sentEmail(ws, c.id, c.email);
    box.add(plainReply({ from: `Ravi <${c.email}>`, inReplyTo: ours.messageId, text: "Please stop.\r\n\r\nOn Mon, Asha wrote:\r\n> Hi" }));
    await poll(ws, box);
    expect((await events(ws))[0]).toMatchObject({ reply_label: "asked_to_stop", reply_label_source: "keyword", classification_status: "done" });
    expect(await emailStatus(c.id)).toBe("unsubscribed");
    expect(await leadRow(c.id)).toMatchObject({ agent_status: "stopped", agent_status_reason: "asked_to_stop", lifecycle_state: "active" });
    expect(await tasks(c.id)).toEqual([{ title: "Asked to stop by email — review today", status: "open", origin: "agent" }]);
  });

  it("the email reply API: owner and admin read (audited, no-store), other rep 403; label correction; email status clear is admin-only", async () => {
    const { ws, box } = await workspace("api");
    const c = await contact(ws);
    const ours = await sentEmail(ws, c.id, c.email);
    const text = secret("Can we talk on Friday");
    box.add(plainReply({ from: `Ravi <${c.email}>`, inReplyTo: ours.messageId, subject: "Re: Pricing", text }));
    await poll(ws, box);
    const [event] = await events(ws);

    const page = await api.call(owner, ws, "GET", `/contacts/${c.id}/timeline`);
    const row = page.body.data.find((r: { title: string }) => r.title === "Replied by email");
    expect(row.reply).toEqual({ channel: "email", messageId: event.id, hasText: true, label: null, labelSource: null, labelBy: null, classifying: true, canRead: true, canCorrect: true, drafting: true, draft: null });

    const read = await api.call(owner, ws, "GET", `/contacts/${c.id}/email-replies/${event.id}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(read.body).toMatchObject({ replyId: event.id, subject: "Re: Pricing", text, truncated: false });
    expect((await api.call(admin, ws, "GET", `/contacts/${c.id}/email-replies/${event.id}`)).status).toBe(200);
    const denied = await api.call(otherRep, ws, "GET", `/contacts/${c.id}/email-replies/${event.id}`);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect((await api.call(owner, ws, "GET", `/contacts/${c.id}/email-replies/${randomUUID()}`)).status).toBe(404);
    const audit = await pool.query(`select channel, viewer_id, outcome from public.inbound_message_views where email_event_id = $1 order by viewed_at`, [event.id]);
    expect(audit.rows).toEqual([
      { channel: "email", viewer_id: owner.id, outcome: "shown" },
      { channel: "email", viewer_id: admin.id, outcome: "shown" },
      { channel: "email", viewer_id: otherRep.id, outcome: "denied" },
    ]);
    const otherView = await api.call(otherRep, ws, "GET", `/contacts/${c.id}/timeline`);
    expect(otherView.body.data.find((r: { title: string }) => r.title === "Replied by email").reply).toMatchObject({ canRead: false, canCorrect: false });

    expect((await api.call(otherRep, ws, "PUT", `/contacts/${c.id}/email-replies/${event.id}/label`, { label: "question" })).status).toBe(403);
    const corrected = await api.call(owner, ws, "PUT", `/contacts/${c.id}/email-replies/${event.id}/label`, { label: "question" });
    expect(corrected.body).toEqual({ messageId: event.id, label: "question", labelSource: "rep", labelBy: owner.fullName });
    expect(await tasks(c.id)).toEqual([{ title: "Asked a question — respond today", status: "open", origin: "agent" }]);

    // Rule 6: clearing a bounce / unsubscribe is admin-only with a reason.
    await pool.query(`insert into public.lead_contact_channels (lead_id, channel, status, reason) values ($1, 'email', 'permanent_bounce', 'bounced')`, [c.id]);
    expect((await api.call(owner, ws, "POST", `/leads/${c.id}/contactability`, { channel: "email", status: "valid", reason: "fixed" })).status).toBe(403);
    expect((await api.call(admin, ws, "POST", `/leads/${c.id}/contactability`, { channel: "email", status: "valid" })).status).toBe(400);
    expect((await api.call(admin, ws, "POST", `/leads/${c.id}/contactability`, { channel: "email", status: "valid", reason: "New address confirmed" })).status).toBe(200);
    expect(await emailStatus(c.id)).toBe("valid");
    expect(await timeline(c.id)).toContain(`Email status cleared by ${admin.fullName}: New address confirmed`);

    // Settings: the Replies & bounces block; Check now is admin-only and only schedules the next poll.
    const settings = await api.call(owner, ws, "GET", "/connections/email/settings");
    expect(settings.body.imapStatus).toMatchObject({ lastError: null, today: { replies: 1, bounces: 0, autoReplies: 0, unsubscribes: 0, unmatched: 0 }, bounces24h: 0 });
    expect(settings.body.imapStatus.lastSuccessAt).not.toBeNull();
    expect((await api.call(owner, ws, "POST", "/connections/email/check-now")).status).toBe(403);
    const calls = box.calls.length;
    await pool.query(`update public.email_imap_state set next_poll_at = now() + interval '1 hour' where workspace_id = $1`, [ws]);
    const checked = await api.call(admin, ws, "POST", "/connections/email/check-now");
    expect(checked.status).toBe(200);
    expect(box.calls.length).toBe(calls);
    expect(new Date((await state(ws)).next_poll_at).getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});
