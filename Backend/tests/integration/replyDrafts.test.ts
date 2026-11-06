/**
 * E3b-2a: reply drafts for reps, the rep's Send, the 2-hour escalation, the meeting-outcome task and
 * the booking-link audit. Replies arrive through the real processInboundUpsert; the label and draft
 * steps run with the fake model (never OpenAI); WhatsApp sends use a fake sender, emails a dry run.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import { fakeEmbedder } from "../helpers/fakeEmbedder.js";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import type { ReplyClassification } from "../../src/agent/replyClassification.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const PRICES = { "m-decide": { inputPer1M: 2, outputPer1M: 8 }, "m-ground": { inputPer1M: 1, outputPer1M: 4 } };
const MODELS = { decision: "m-decide", grounding: "m-ground" };
const GOOD_WA = "Thanks, Asha. Our team works with steel traders on finding new buyers. Would Thursday or Friday suit you for a short call?";
const ist = (local: string) => new Date(`${local}:00+05:30`);

const wa = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });
const mail = (body: string): AgentDecision => ({ action: "send_email", subject: "-", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });

describeIfDb("E3b-2a reply drafts (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let owner: Actor;
  let admin: Actor;
  let otherRep: Actor;
  let api: TestApi;
  const logged: string[] = [];
  const secrets: string[] = [];

  const randomPhone = () => `+9196${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const secret = (text: string) => {
    const marker = `${text} [e3b2a-${randomUUID().slice(0, 8)}]`;
    secrets.push(marker);
    return marker;
  };

  async function scenario(opts: { mode?: "off" | "shadow"; agentStatus?: string; budget?: number } = {}) {
    const ws = await createTestWorkspace(pool, "reply-drafts");
    await pool.query(`update public.agent_settings set mode = $2, monthly_budget_usd = $3 where workspace_id = $1`, [ws, opts.mode ?? "shadow", opts.budget ?? 100]);
    const phone = randomPhone();
    const lead = await pool.query(
      `insert into public.leads (workspace_id, first_name, last_name, company, source, email, phone, phone_e164, owner_id, agent_status, pipeline_stage)
       values ($1, 'Asha', 'Rao', 'Acme Steel', 'referral', $2, $3, $3, $4, $5, 'connected_qualifying') returning id`,
      [ws, `e3b2a-${randomUUID()}@example.com`, phone, owner.id, opts.agentStatus ?? "active"],
    );
    return { ws, phone, leadId: lead.rows[0].id as string };
  }

  async function inbound(ws: string, phone: string, text: string) {
    const id = `e3b2a-${randomUUID()}`;
    const { processInboundUpsert } = await import("../../src/services/whatsapp-inbound.service.js");
    await processInboundUpsert(ws, {
      type: "notify",
      messages: [{ key: { id, remoteJid: `${phone.slice(1)}@s.whatsapp.net`, fromMe: false }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) }],
    } as never);
    return id;
  }

  const fake = (opts: { replies?: ReplyClassification[]; decisions?: AgentDecision[] } = {}) =>
    createFakeDecisionModel({ replies: opts.replies ?? [{ label: "question", confidence: 0.9 }], decisions: opts.decisions ?? [wa(GOOD_WA)] });

  // E3b-2a-2: the draft waits for 3 quiet minutes; `quiet` makes them pass (draft_next_at → now).
  async function labelAndDraft(ws: string, model: ReturnType<typeof fake>, opts: { quiet?: boolean } = {}) {
    const { runReplyClassification } = await import("../../src/services/replyClassifier.service.js");
    const { runReplyDrafts } = await import("../../src/services/replyDrafts.service.js");
    await runReplyClassification(true, { model, prices: PRICES, defaultModels: MODELS, workspaceIds: [ws] });
    if (opts.quiet ?? true) {
      for (const table of ["whatsapp_inbound_events", "email_inbound_events"]) {
        await pool.query(`update public.${table} set draft_next_at = now() where workspace_id = $1 and draft_status = 'pending'`, [ws]);
      }
    }
    return runReplyDrafts(true, { model, embedder: fakeEmbedder, prices: PRICES, defaultModels: MODELS, workspaceIds: [ws] });
  }
  const replyBlock = (model: ReturnType<typeof fake>) => {
    const calls = model.calls.filter((c) => c.kind === "decide");
    return /<reply>\n([\s\S]*?)\n<\/reply>/.exec(calls[calls.length - 1]!.input.messages[1]!.content)?.[1] ?? "";
  };

  const drafts = async (leadId: string) =>
    (await pool.query(`select id, status, body, problems, cost_usd, send_status, edited, sent_body from public.reply_drafts where lead_id = $1 order by created_at`, [leadId])).rows;
  const openTasks = async (leadId: string) => (await pool.query(`select id, title from public.tasks where lead_id = $1 and status = 'open'`, [leadId])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "reply-drafts");
    owner = await api.newUser("salesperson", { name: "E3b2a Owner" });
    admin = await api.newUser("admin", { name: "E3b2a Admin" });
    otherRep = await api.newUser("salesperson", { name: "E3b2a Other" });
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    // Rule 2: the lead's reply text is never logged or stored in a draft.
    for (const marker of secrets) expect(logged.join("\n")).not.toContain(marker);
    const stored = await pool.query(`select coalesce(string_agg(row_to_json(d)::text, ' '), '') as all from public.reply_drafts d join public.workspaces w on w.id = d.workspace_id where w.name like '[test] reply-drafts%'`);
    for (const marker of secrets) expect(stored.rows[0].all).not.toContain(marker);
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("an eligible label gets ONE draft: cost recorded, counted toward the daily cap and the month's spend; the AI stays handed off", async () => {
    const { ws, phone, leadId } = await scenario();
    const id = await inbound(ws, phone, secret("Do you work with steel traders?"));
    expect((await pool.query(`select draft_status from public.whatsapp_inbound_events where message_id = $1`, [id])).rows[0].draft_status).toBe("pending");
    const model = fake();
    expect(await labelAndDraft(ws, model)).toEqual([{ replyId: id, result: "drafted" }]);
    const rows = await drafts(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "open", body: GOOD_WA, problems: null });
    // decide 1000/200 at 2/8 + grounding 1000/200 at 1/4 per 1M.
    expect(Number(rows[0].cost_usd)).toBeCloseTo(0.0054, 6);
    // The reply text reached the model only inside the delimited block.
    const draftCall = model.calls.find((c) => c.kind === "decide")!;
    expect(draftCall.input.messages[1]!.content).toMatch(/<reply>\nDo you work with steel traders\? \[e3b2a-/);
    const { DAY_DECISIONS_SQL, MONTH_SPEND_SQL } = await import("../../src/services/agentRunner.service.js");
    const counted = (await pool.query(`select ${DAY_DECISIONS_SQL} as n, ${MONTH_SPEND_SQL}::float8 as spent`, [ws])).rows[0];
    // E3b-2a-2: the AI label and the draft both count toward the daily cap.
    expect(counted.n).toBe(2);
    expect(counted.spent).toBeGreaterThan(0.0054);
    expect((await pool.query(`select agent_status from public.leads where id = $1`, [leadId])).rows[0].agent_status).toBe("handed_off");
    // At most one draft per reply: another tick does nothing.
    expect(await labelAndDraft(ws, model)).toEqual([]);
  });

  it("no draft for stop / not interested, an opted-out channel, mode off, a used-up budget or a contact the AI didn't manage", async () => {
    const stop = await scenario();
    await inbound(stop.ws, stop.phone, "STOP");
    const notInterested = await scenario();
    await inbound(notInterested.ws, notInterested.phone, secret("We already have a vendor"));
    const optedOut = await scenario();
    await pool.query(`insert into public.lead_contact_channels (lead_id, channel, status, reason) values ($1, 'whatsapp', 'opted_out', 'test')`, [optedOut.leadId]);
    await inbound(optedOut.ws, optedOut.phone, secret("What do you charge?"));
    const off = await scenario({ mode: "off" });
    await inbound(off.ws, off.phone, secret("Tell me more"));
    // The label step (20,000 tokens at $1 per 1M = $0.02) uses up the $0.01 budget, so the draft step finds none left.
    const broke = await scenario({ budget: 0.01 });
    await inbound(broke.ws, broke.phone, secret("Tell me more"));
    const notManaged = await scenario({ agentStatus: "none" });
    await inbound(notManaged.ws, notManaged.phone, secret("Tell me more"));

    const stopModel = fake();
    expect(await labelAndDraft(stop.ws, stopModel)).toMatchObject([{ result: "skipped", reason: "label asked_to_stop" }]);
    expect(stopModel.calls).toEqual([]);
    expect(await labelAndDraft(notInterested.ws, fake({ replies: [{ label: "not_interested", confidence: 0.9 }] }))).toMatchObject([{ result: "skipped", reason: "label not_interested" }]);
    expect(await labelAndDraft(optedOut.ws, fake())).toMatchObject([{ result: "skipped", reason: "The contact opted out of WhatsApp." }]);
    expect(await labelAndDraft(off.ws, fake())).toEqual([]);
    const pricey = createFakeDecisionModel({ replies: [{ label: "question", confidence: 0.9 }], decisions: [wa(GOOD_WA)], tokens: { input: 20000, output: 0 } });
    expect(await labelAndDraft(broke.ws, pricey)).toMatchObject([{ result: "skipped", reason: "monthly budget reached" }]);
    expect(await labelAndDraft(notManaged.ws, fake())).toEqual([]);
    for (const s of [stop, notInterested, optedOut, off, broke, notManaged]) expect(await drafts(s.leadId)).toEqual([]);
  });

  it("a draft failing the checks twice is not saved as a draft; the cost is recorded and the reply task stays open", async () => {
    const { ws, phone, leadId } = await scenario();
    await inbound(ws, phone, secret("Can you help us?"));
    const twoQuestions = wa("Can we talk this week about buyers? Would Thursday suit you?");
    const model = fake({ decisions: [twoQuestions] });
    expect(await labelAndDraft(ws, model)).toMatchObject([{ result: "failed" }]);
    expect(model.calls.filter((c) => c.kind === "decide")).toHaveLength(2);
    expect(model.calls.find((c) => c.kind === "decide" && c.input.messages[1]!.content.includes("Your previous draft was rejected"))).toBeTruthy();
    const rows = await drafts(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", body: null });
    expect(rows[0].problems).toEqual(expect.arrayContaining(["one_question", "banned_phrase"]));
    expect(await openTasks(leadId)).toHaveLength(1);
  });

  it("a new reply supersedes the open draft at once; a contact handed off for another reason (no reply task, no draft) gets no label or draft", async () => {
    const { ws, phone, leadId } = await scenario();
    await inbound(ws, phone, secret("Do you work in Pune?"));
    await labelAndDraft(ws, fake());
    await inbound(ws, phone, secret("Thanks"));
    expect((await drafts(leadId)).map((d) => d.status)).toEqual(["superseded"]);

    const other = await scenario({ agentStatus: "handed_off" });
    const id = await inbound(other.ws, other.phone, secret("Any update?"));
    expect((await pool.query(`select draft_status, classification_status from public.whatsapp_inbound_events where message_id = $1`, [id])).rows[0]).toMatchObject({
      draft_status: null,
      classification_status: "skipped",
    });
  });

  it("E3b-2a-2 burst: 'Hi' then a question a minute later → one draft after 3 quiet minutes, answering both", async () => {
    const { ws, phone, leadId } = await scenario();
    const hi = await inbound(ws, phone, secret("Hi"));
    const question = await inbound(ws, phone, secret("Do you work with steel traders in Pune?"));
    // The follow-up (handed off by "Hi", reply task open) is labelled too; the first reply's draft step folds into the second.
    const events = await pool.query(`select message_id, draft_status, draft_next_at > now() + interval '2 minutes' as waits from public.whatsapp_inbound_events where lead_id = $1`, [leadId]);
    expect(Object.fromEntries(events.rows.map((r) => [r.message_id, [r.draft_status, r.waits]]))).toEqual({ [hi]: ["skipped", null], [question]: ["pending", true] });
    const model = fake({ replies: [{ label: "other", confidence: 0.9 }, { label: "question", confidence: 0.9 }] });
    // Not quiet yet: labelled, nothing drafted.
    expect(await labelAndDraft(ws, model, { quiet: false })).toEqual([]);
    expect(model.calls.filter((c) => c.kind === "reply")).toHaveLength(2);
    expect(await labelAndDraft(ws, model)).toEqual([{ replyId: question, result: "drafted" }]);
    expect(replyBlock(model)).toMatch(/^Hi \[e3b2a-\w+\]\n\n---\n\nDo you work with steel traders in Pune\? \[e3b2a-\w+\]$/);
    const rows = await drafts(leadId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].cost_usd)).toBeGreaterThan(0);
  });

  it("E3b-2a-2: at most 3 drafts per contact per IST day; every label and draft counts toward the daily cap", async () => {
    const { ws, phone, leadId } = await scenario();
    const outcomes: string[] = [];
    for (const text of ["Hi", "Do you work in Pune?", "And Nashik?", "One more thing"]) {
      await inbound(ws, phone, secret(text));
      outcomes.push(...(await labelAndDraft(ws, fake())).map((o) => o.reason ?? o.result));
    }
    expect(outcomes).toEqual(["drafted", "drafted", "drafted", "contact's daily draft limit reached"]);
    // The 4th reply still supersedes the open draft (newest reply wins); it just gets none of its own.
    expect((await drafts(leadId)).map((d) => d.status)).toEqual(["superseded", "superseded", "superseded"]);
    const { DAY_DECISIONS_SQL } = await import("../../src/services/agentRunner.service.js");
    // 4 AI labels + 3 drafts.
    expect((await pool.query(`select ${DAY_DECISIONS_SQL} as n`, [ws])).rows[0].n).toBe(7);
  });

  it("E3b-2a-2: a stop label on any reply in the burst → no draft, and its effects apply", async () => {
    const { ws, phone, leadId } = await scenario();
    await inbound(ws, phone, secret("Why do you keep writing"));
    await inbound(ws, phone, secret("What do you charge?"));
    const model = fake({ replies: [{ label: "annoyed", confidence: 0.9 }, { label: "question", confidence: 0.9 }] });
    expect(await labelAndDraft(ws, model)).toMatchObject([{ result: "skipped", reason: "label annoyed" }]);
    expect(model.calls.filter((c) => c.kind === "decide")).toEqual([]);
    expect(await drafts(leadId)).toEqual([]);
    expect((await pool.query(`select agent_status from public.leads where id = $1`, [leadId])).rows[0].agent_status).toBe("stopped");
  });

  it("E3b-2a-2: after the rep sends, the next reply starts a new burst and gets its own draft", async () => {
    const { ws, phone, leadId } = await scenario();
    await inbound(ws, phone, secret("Do you work with steel traders?"));
    await labelAndDraft(ws, fake());
    const [first] = await drafts(leadId);
    const { sendReplyDraft } = await import("../../src/services/replyDrafts.service.js");
    await sendReplyDraft(owner, ws, leadId, first.id, GOOD_WA);
    expect(await openTasks(leadId)).toEqual([]);
    const next = await inbound(ws, phone, secret("Thursday works"));
    // A new reply task for the owner, and a draft that sees only the new reply.
    expect(await openTasks(leadId)).toHaveLength(1);
    const model = fake({ replies: [{ label: "positive", confidence: 0.9 }] });
    expect(await labelAndDraft(ws, model)).toEqual([{ replyId: next, result: "drafted" }]);
    expect(replyBlock(model)).toMatch(/^Thursday works \[e3b2a-\w+\]$/);
    expect((await drafts(leadId)).map((d) => d.status)).toEqual(["sent", "open"]);
  });

  it("the rep's Send: owner/admin only, word limit 400, queued (never sent in the request), task done, idempotent; the worker sends through the reply_draft source", async () => {
    const { ws, phone, leadId } = await scenario();
    const replyId = await inbound(ws, phone, secret("Do you work with steel traders?"));
    await labelAndDraft(ws, fake());
    const [draft] = await drafts(leadId);
    const { sendReplyDraft, discardReplyDraft, runReplyDraftSends } = await import("../../src/services/replyDrafts.service.js");

    await expect(sendReplyDraft(otherRep, ws, leadId, draft.id, GOOD_WA)).rejects.toMatchObject({ status: 403 });
    await expect(sendReplyDraft(owner, ws, randomUUID(), draft.id, GOOD_WA)).rejects.toMatchObject({ status: 404 });
    const long = Array.from({ length: 61 }, () => "word").join(" ");
    await expect(sendReplyDraft(owner, ws, leadId, draft.id, long)).rejects.toMatchObject({ status: 400, message: "WhatsApp replies can be at most 60 words; this one has 61." });

    const edited = `${GOOD_WA.replace("Thursday or Friday", "Monday or Tuesday")}`;
    // Sunday evening: outside the window → queued for Monday 09:30 IST ("Will send at …").
    const sent = await sendReplyDraft(owner, ws, leadId, draft.id, edited, ist("2026-11-08T20:00"));
    expect(sent).toMatchObject({ status: "sent", sendStatus: "queued", sendAt: ist("2026-11-09T09:30").toISOString(), edited: true, sentBody: edited });
    expect(await openTasks(leadId)).toEqual([]);
    expect(await sendReplyDraft(owner, ws, leadId, draft.id, "something else")).toMatchObject({ status: "sent", sentBody: edited });
    await expect(discardReplyDraft(owner, ws, leadId, draft.id)).rejects.toMatchObject({ status: 409 });

    // The re-check under row locks (performSend): the phone while sending; null once opted out.
    const { loadSourceEligibility } = await import("../../src/providers/baileys.manager.js");
    await pool.query(`update public.reply_drafts set send_status = 'sending' where id = $1`, [draft.id]);
    const client = await pool.connect();
    try {
      await client.query("begin");
      expect(await loadSourceEligibility(client, ws, { type: "reply_draft", id: draft.id })).toBe(phone);
      await client.query(`insert into public.lead_contact_channels (lead_id, channel, status, reason) values ($1, 'whatsapp', 'opted_out', 'test') on conflict (lead_id, channel) do update set status = 'opted_out'`, [leadId]);
      expect(await loadSourceEligibility(client, ws, { type: "reply_draft", id: draft.id })).toBeNull();
      await client.query("rollback");
    } finally {
      client.release();
    }

    await pool.query(`update public.reply_drafts set send_status = 'queued', send_next_at = now() where id = $1`, [draft.id]);
    const sendCalls: { source: unknown; to: string; body: string }[] = [];
    const results = await runReplyDraftSends({ workspaceIds: [ws], send: async (_ws, input) => (sendCalls.push(input), { providerMessageId: "wamid-test" }) });
    expect(results).toEqual([{ id: draft.id, result: "sent" }]);
    expect(sendCalls).toEqual([{ source: { type: "reply_draft", id: draft.id }, to: phone, body: `${edited}\n\nE3b2a, ${(await pool.query(`select name from public.workspaces where id = $1`, [ws])).rows[0].name}` }]);
    expect((await drafts(leadId))[0]).toMatchObject({ send_status: "sent" });
    const timeline = await pool.query(`select title, detail from public.timeline_events where lead_id = $1 and metadata->>'replyDraftId' = $2`, [leadId, draft.id]);
    expect(timeline.rows).toEqual([{ title: "Reply sent on WhatsApp", detail: "Suggested reply, edited, sent by E3b2a Owner" }]);
    expect(replyId).toBeTruthy();
  });

  it("DNC blocks the Send (409) and an admin can discard", async () => {
    const { ws, phone, leadId } = await scenario();
    await inbound(ws, phone, secret("Interested, tell me more"));
    await labelAndDraft(ws, fake());
    const [draft] = await drafts(leadId);
    const { sendReplyDraft, discardReplyDraft } = await import("../../src/services/replyDrafts.service.js");
    await pool.query(`update public.leads set lifecycle_state = 'do_not_contact', dnc_reason = 'requested' where id = $1`, [leadId]);
    await expect(sendReplyDraft(admin, ws, leadId, draft.id, GOOD_WA)).rejects.toMatchObject({ status: 409, message: "The contact is Do Not Contact." });
    expect(await discardReplyDraft(admin, ws, leadId, draft.id)).toMatchObject({ status: "discarded" });
  });

  it("an email reply: the draft keeps our thread's subject, the Send queues a reply_draft email that continues the lead's message", async () => {
    const { ws, leadId } = await scenario();
    const { encryptText } = await import("../../src/security/encryption.js");
    const eventId = randomUUID();
    const body = encryptText(JSON.stringify({ subject: "Re: Buyers", text: secret("Which regions do you cover?") }), `email:inbound:${eventId}`);
    const outbound = await pool.query(
      `insert into public.email_outbound_messages (workspace_id, source, source_id, lead_id, to_address, to_contact, subject, html, text_body, status)
       values ($1, 'test', $2, $3, 'x@example.com', true, 'New buyers for Acme Steel', '<p>x</p>', 'x', 'sent') returning id`,
      [ws, randomUUID(), leadId],
    );
    await pool.query(
      `insert into public.email_inbound_events (id, workspace_id, message_id_header, uidvalidity, uid, from_address, received_at, kind, match_status, match_method, lead_id, outbound_id,
                                               body_ciphertext, body_iv, body_tag, body_key_version, reply_label, reply_label_source, classification_status, draft_status, draft_next_at)
       values ($1, $2, '<lead-msg@example.com>', 1, 1, 'asha@example.com', now(), 'reply', 'matched', 'in_reply_to', $3, $4, $5, $6, $7, $8, 'question', 'ai', 'done', 'pending', now())`,
      [eventId, ws, leadId, outbound.rows[0].id, body.ciphertext, body.iv, body.tag, body.keyVersion],
    );
    const { runReplyDrafts, sendReplyDraft } = await import("../../src/services/replyDrafts.service.js");
    const text = "Hi Asha,\n\nWe work with buyers across western and southern India. Would Thursday or Friday suit you for a short call?";
    expect(await runReplyDrafts(true, { model: fake({ decisions: [mail(text)] }), embedder: fakeEmbedder, prices: PRICES, defaultModels: MODELS, workspaceIds: [ws] })).toEqual([
      { replyId: eventId, result: "drafted" },
    ]);
    const draft = (await pool.query(`select id, subject, in_reply_to from public.reply_drafts where email_event_id = $1`, [eventId])).rows[0];
    expect(draft).toMatchObject({ subject: "Re: New buyers for Acme Steel", in_reply_to: "<lead-msg@example.com>" });

    await sendReplyDraft(owner, ws, leadId, draft.id, text);
    const queued = (await pool.query(`select source, status, subject, text_body from public.email_outbound_messages where source = 'reply_draft' and source_id = $1`, [draft.id])).rows;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "queued", subject: "Re: New buyers for Acme Steel" });
    expect(queued[0].text_body).toContain("Best regards,\nE3b2a Owner");

    // The email queue's write-back (dry run: no SMTP).
    await pool.query(`update public.email_outbound_messages set next_attempt_at = now() where source = 'reply_draft' and source_id = $1`, [draft.id]);
    const { runEmailOutbound } = await import("../../src/services/emailOutbound.service.js");
    await runEmailOutbound({ dryRun: true, workspaceIds: [ws] });
    expect((await pool.query(`select send_status from public.reply_drafts where id = $1`, [draft.id])).rows[0].send_status).toBe("sent");
  });

  it("API: the draft on the timeline reply row and the task's latest draft (owner/admin only), Send / Discard with 403 / 404 / 400", async () => {
    const { ws, phone, leadId } = await scenario();
    const replyId = await inbound(ws, phone, secret("Do you work with steel traders?"));
    await labelAndDraft(ws, fake());
    const timelineRow = async (as: Actor) =>
      (await api.call(as, ws, "GET", `/contacts/${leadId}/timeline`)).body.data.find((r: { reply?: { messageId: string } }) => r.reply?.messageId === replyId);
    const ownerRow = await timelineRow(owner);
    expect(ownerRow.reply).toMatchObject({ drafting: false, draft: { status: "open", body: GOOD_WA, canSend: true, channel: "whatsapp" } });
    expect((await timelineRow(otherRep)).reply.draft).toBeNull();
    const draftId = ownerRow.reply.draft.id as string;

    expect((await api.call(otherRep, ws, "GET", `/contacts/${leadId}/reply-drafts/latest`)).status).toBe(403);
    expect((await api.call(admin, ws, "GET", `/contacts/${leadId}/reply-drafts/latest`)).body.draft).toMatchObject({ id: draftId, status: "open" });
    expect((await api.call(otherRep, ws, "POST", `/contacts/${leadId}/reply-drafts/${draftId}/send`, { body: GOOD_WA })).status).toBe(403);
    expect((await api.call(owner, ws, "POST", `/contacts/${leadId}/reply-drafts/${randomUUID()}/send`, { body: GOOD_WA })).status).toBe(404);
    const long = await api.call(owner, ws, "POST", `/contacts/${leadId}/reply-drafts/${draftId}/send`, { body: Array.from({ length: 70 }, () => "word").join(" ") });
    expect(long.status).toBe(400);
    expect(JSON.stringify(long.body)).toContain("WhatsApp replies can be at most 60 words; this one has 70.");
    expect((await api.call(owner, ws, "POST", `/contacts/${leadId}/reply-drafts/${draftId}/send`, {})).status).toBe(400);

    const discarded = await api.call(owner, ws, "POST", `/contacts/${leadId}/reply-drafts/${draftId}/discard`);
    expect(discarded).toMatchObject({ status: 200, body: { status: "discarded", canSend: false } });
    expect((await api.call(owner, ws, "POST", `/contacts/${leadId}/reply-drafts/${draftId}/send`, { body: GOOD_WA })).status).toBe(409);
    expect((await timelineRow(owner)).reply.draft).toBeNull();
    expect(await openTasks(leadId)).toHaveLength(1);
  });

  it("escalation: once, only after 2 working hours (send window, IST), to admins", async () => {
    const { ws, leadId } = await scenario();
    const created = ist("2026-10-28T18:00"); // a Wednesday, 1 working hour before closing
    const task = await pool.query(
      `insert into public.tasks (workspace_id, lead_id, owner_id, owner_name, task_type, title, due_at, origin, created_at)
       values ($1, $2, $3, 'E3b2a Owner', 'follow_up', 'Asked a question — respond today', $4, 'agent', $4) returning id`,
      [ws, leadId, owner.id, created],
    );
    const { runReplyEscalation } = await import("../../src/services/workReminders.service.js");
    expect(await runReplyEscalation({ now: ist("2026-10-28T21:00"), workspaceIds: [ws] })).toEqual([]);
    expect(await runReplyEscalation({ now: ist("2026-10-29T10:29"), workspaceIds: [ws] })).toEqual([]);
    expect(await runReplyEscalation({ now: ist("2026-10-29T10:31"), workspaceIds: [ws] })).toEqual([task.rows[0].id]);
    expect(await runReplyEscalation({ now: ist("2026-10-29T12:00"), workspaceIds: [ws] })).toEqual([]);
    const notes = await pool.query(`select recipient_id, title from public.notifications where lead_id = $1 and title like '%hasn''t answered%'`, [leadId]);
    expect(notes.rows.map((n) => n.recipient_id)).toContain(admin.id);
    expect(notes.rows.map((n) => n.recipient_id)).not.toContain(owner.id);
    expect(new Set(notes.rows.map((n) => n.title))).toEqual(new Set(["E3b2a Owner hasn't answered Asha Rao's reply yet (2 h)"]));
  });

  it("meeting outcome task: once per meeting, only 2 days after it", async () => {
    const { ws, leadId } = await scenario();
    const insert = (when: string) =>
      pool.query(`insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status) values ($1, $2, $3, 'Intro', now() - $4::interval, 'scheduled') returning id`, [ws, leadId, owner.id, when]);
    const old = await insert("3 days");
    await insert("1 day");
    const { runMeetingOutcomeTasks } = await import("../../src/services/workReminders.service.js");
    expect(await runMeetingOutcomeTasks({ workspaceIds: [ws] })).toEqual([old.rows[0].id]);
    expect(await runMeetingOutcomeTasks({ workspaceIds: [ws] })).toEqual([]);
    expect((await openTasks(leadId)).map((t) => t.title)).toEqual(["Log the meeting outcome"]);
  });

  it("an admin changing someone else's booking link is audited", async () => {
    const { updateSalesperson } = await import("../../src/services/admin-users.service.js");
    await updateSalesperson(admin, { id: otherRep.id, bookingUrl: "https://cal.example.com/other" });
    await updateSalesperson(admin, { id: otherRep.id, bookingUrl: "https://cal.example.com/other" });
    const audit = await pool.query(`select actor_id, metadata from public.admin_audit_events where action = 'user.booking_url_changed' and target_id = $1`, [otherRep.id]);
    expect(audit.rows).toEqual([{ actor_id: admin.id, metadata: { removed: false, hadLink: false } }]);
  });
});
