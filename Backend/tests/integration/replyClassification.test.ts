/**
 * D4a: WhatsApp reply labels. Replies arrive through the real processInboundUpsert
 * (keyword check + pending mark in the same transaction); the worker step runs
 * runReplyClassification with the fake model (never OpenAI). Nothing is sent.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { fakeEmbedder } from "../helpers/fakeEmbedder.js";
import type { ReplyClassification } from "../../src/agent/replyClassification.js";
import { ModelOutputError } from "../../src/providers/provider-errors.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const PRICES = { "m-decide": { inputPer1M: 2, outputPer1M: 8 }, "m-ground": { inputPer1M: 1, outputPer1M: 4 } };
const MODELS = { decision: "m-decide", grounding: "m-ground" };
const DEFAULT_TITLE = "Lead replied on WhatsApp — respond today";

describeIfDb("WhatsApp reply labels (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let owner: Actor;
  const logged: string[] = [];
  const secrets: string[] = [];

  const randomPhone = () => `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  /** A reply text with a unique marker that must never show up anywhere but body_*. */
  const secret = (text: string) => {
    const marker = `${text} [d4a-${randomUUID().slice(0, 8)}]`;
    secrets.push(marker);
    return marker;
  };

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

  async function scenario(opts: { mode?: "off" | "shadow"; agentStatus?: string; budget?: number } = {}) {
    const ws = await createTestWorkspace(pool, "reply-labels");
    await pool.query(`update public.agent_settings set mode = $2, monthly_budget_usd = $3 where workspace_id = $1`, [ws, opts.mode ?? "shadow", opts.budget ?? 100]);
    const phone = randomPhone();
    const lead = await pool.query(
      `insert into public.leads (workspace_id, first_name, last_name, company, source, email, phone, phone_e164, owner_id, agent_status, pipeline_stage)
       values ($1, 'Asha', 'Rao', 'Acme Steel', 'referral', $2, $3, $3, $4, $5, 'connected_qualifying') returning id`,
      [ws, `d4a-${randomUUID()}@example.com`, phone, owner.id, opts.agentStatus ?? "active"],
    );
    return { ws, phone, leadId: lead.rows[0].id as string };
  }

  async function inbound(ws: string, phone: string, text: string, id = `d4a-${randomUUID()}`) {
    const { processInboundUpsert } = await import("../../src/services/whatsapp-inbound.service.js");
    await processInboundUpsert(ws, {
      type: "notify",
      messages: [{ key: { id, remoteJid: `${phone.slice(1)}@s.whatsapp.net`, fromMe: false }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) }],
    } as never);
    return id;
  }

  async function classify(ws: string, model: ReturnType<typeof createFakeDecisionModel>) {
    const { runReplyClassification } = await import("../../src/services/replyClassifier.service.js");
    return runReplyClassification(true, { model, prices: PRICES, defaultModels: MODELS, workspaceIds: [ws], backoffMs: () => 0 });
  }

  const fake = (...replies: (ReplyClassification | Error)[]) => createFakeDecisionModel({ replies, tokens: { input: 300, output: 10 } });
  const event = async (id: string) => (await pool.query(`select * from public.whatsapp_inbound_events where message_id = $1`, [id])).rows[0];
  const leadRow = async (id: string) => (await pool.query(`select agent_status, agent_status_reason, lifecycle_state from public.leads where id = $1`, [id])).rows[0];
  const whatsappStatus = async (id: string) =>
    (await pool.query(`select status from public.lead_contact_channels where lead_id = $1 and channel = 'whatsapp'`, [id])).rows[0]?.status ?? null;
  const tasks = async (id: string) => (await pool.query(`select title, status from public.tasks where lead_id = $1 order by created_at`, [id])).rows;
  const stopNotifications = async (id: string) =>
    (await pool.query(`select title, recipient_id from public.notifications where lead_id = $1 and title like '%asked us to stop%'`, [id])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`d4a-owner-${randomUUID()}@example.com`]);
    await pool.query(`update public.profiles set role = 'salesperson', is_active = true, full_name = 'D4a Owner' where id = $1`, [auth.rows[0].id]);
    owner = { id: auth.rows[0].id, email: "d4a@example.com", fullName: "D4a Owner", role: "salesperson" } as Actor;
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await deleteCreatedTestWorkspaces(pool);
    await pool.query(`delete from auth.users where id = $1`, [owner.id]).catch((error: Error) => console.warn(`[d4a] user cleanup failed: ${error.message}`));
    await pool.end();
  });

  it("STOP on a contact not in the AI: keyword label, WhatsApp opted out, owner notified, no AI call, agent untouched, never DNC", async () => {
    const { ws, phone, leadId } = await scenario({ mode: "off", agentStatus: "none" });
    const id = await inbound(ws, phone, "STOP!");
    expect(await event(id)).toMatchObject({ lead_id: leadId, reply_label: "asked_to_stop", reply_label_source: "keyword", classification_status: "done" });
    expect(await whatsappStatus(leadId)).toBe("opted_out");
    expect(await stopNotifications(leadId)).toEqual([{ title: "Asha Rao asked us to stop messaging on WhatsApp", recipient_id: owner.id }]);
    expect(await leadRow(leadId)).toEqual({ agent_status: "none", agent_status_reason: null, lifecycle_state: "active" });
    expect(await tasks(leadId)).toEqual([]);
    const model = fake();
    expect(await classify(ws, model)).toEqual([]);
    expect(model.calls).toEqual([]);

    // A re-delivered event and a second STOP change nothing; a later reply doesn't make WhatsApp reachable again.
    await inbound(ws, phone, "STOP!", id);
    await inbound(ws, phone, "stop");
    await inbound(ws, phone, secret("Hello again"));
    expect(await whatsappStatus(leadId)).toBe("opted_out");
    expect(await stopNotifications(leadId)).toHaveLength(1);
    const optOutRows = await pool.query(`select 1 from public.timeline_events where lead_id = $1 and title = 'whatsapp contactability: opted_out'`, [leadId]);
    expect(optOutRows.rowCount).toBe(1);

    // The opt-out blocks every WhatsApp path through the existing checks.
    await pool.query(`update public.leads set automation_mode = 'active' where id = $1`, [leadId]);
    const { createTemplate, createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const { enrollLeadInWorkflow } = await import("../../src/services/runs.service.js");
    const { getActionContext } = await import("../../src/services/automation.service.js");
    const template = await inTransaction((c) => createTemplate(c, owner, ws, { name: `D4a WA ${randomUUID()}`, channel: "whatsapp", body: "<p>Hi {{lead.firstName}}</p>" }));
    const workflow = await inTransaction((c) => createWorkflow(c, owner, ws, { name: `D4a ${randomUUID()}`, trigger: "manual_enrollment" }));
    await inTransaction((c) => updateDraftSteps(c, ws, workflow.id, 1, [{ order: 0, delayDays: 1, action: "send_whatsapp", templateId: template.id, enabled: true }]));
    await inTransaction((c) => publishVersion(c, owner, ws, workflow.id, 1, "keep_existing"));
    await inTransaction((c) => updateWorkflow(c, ws, workflow.id, { status: "active" }));
    const run = await inTransaction((c) => enrollLeadInWorkflow(c, ws, leadId, workflow.id, "D4a test"));
    const action = (await pool.query(`select id from public.scheduled_actions where workflow_run_id = $1`, [run!.id])).rows[0];
    expect((await getActionContext(pool, action.id)).eligibility).toEqual({ ok: false, reason: 'WhatsApp contactability is "opted_out".' });

    const { buildAgentContext } = await import("../../src/services/agentContext.service.js");
    const { whatsappUsable } = await import("../../src/agent/rules.js");
    const ctx = await buildAgentContext(pool, ws, leadId, new Date(), { embedder: fakeEmbedder, fallbackSenderAddress: null });
    expect(whatsappUsable(ctx.rules)).toBe(false);

    const { loadSourceEligibility } = await import("../../src/providers/baileys.manager.js");
    const proposal = await pool.query(
      `insert into public.proposals (workspace_id, lead_id, owner_id, title, status, whatsapp_send_status) values ($1, $2, $3, 'D4a', 'sent', 'sending') returning id`,
      [ws, leadId, owner.id],
    );
    const meeting = await pool.query(
      `insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status, notify_whatsapp_status)
       values ($1, $2, $3, 'D4a', now() + interval '2 days', 'scheduled', 'sending') returning id`,
      [ws, leadId, owner.id],
    );
    await inTransaction(async (c) => {
      expect(await loadSourceEligibility(c, ws, { type: "proposal", id: proposal.rows[0].id })).toBeNull();
      expect(await loadSourceEligibility(c, ws, { type: "meeting", id: meeting.rows[0].id })).toBeNull();
    });
    // Without the opt-out the same sends are eligible.
    await pool.query(`update public.lead_contact_channels set status = 'valid' where lead_id = $1 and channel = 'whatsapp'`, [leadId]);
    await inTransaction(async (c) => {
      expect(await loadSourceEligibility(c, ws, { type: "proposal", id: proposal.rows[0].id })).toBe(phone);
      expect(await loadSourceEligibility(c, ws, { type: "meeting", id: meeting.rows[0].id })).toBe(phone);
    });
    expect((await pool.query(`select lifecycle_state from public.leads where id = $1`, [leadId])).rows[0].lifecycle_state).toBe("active");
  });

  it("STOP on an AI contact: stopped asked_to_stop (permanent), wakeups cancelled, the one reply task re-titled", async () => {
    const { ws, phone, leadId } = await scenario();
    await pool.query(`insert into public.agent_wakeups (workspace_id, lead_id, due_at, reason) values ($1, $2, now() + interval '1 day', 'enrolled')`, [ws, leadId]);
    await inbound(ws, phone, "Please remove me.");
    expect(await leadRow(leadId)).toMatchObject({ agent_status: "stopped", agent_status_reason: "asked_to_stop" });
    expect(await tasks(leadId)).toEqual([{ title: "Asked to stop on WhatsApp — review today", status: "open" }]);
    expect(await whatsappStatus(leadId)).toBe("opted_out");
    expect((await pool.query(`select 1 from public.agent_wakeups where lead_id = $1 and status = 'pending'`, [leadId])).rowCount).toBe(0);
    const { canTransition } = await import("../../src/agent/status.js");
    expect(canTransition("stopped", "enroll", { lifecycleState: "active", nurtureLongTerm: false, statusReason: "asked_to_stop", hasContact: true })).toMatchObject({ ok: false, reason: "permanently_stopped" });
  });

  it("AI says not_interested: stopped not_interested, contactability unchanged, task re-titled, cost recorded and in the monthly spend", async () => {
    const { ws, phone, leadId } = await scenario();
    const id = await inbound(ws, phone, secret("We already have a vendor, please don't follow up"));
    expect(await event(id)).toMatchObject({ classification_status: "pending", reply_label: null });
    expect(await leadRow(leadId)).toMatchObject({ agent_status: "handed_off" });

    const model = fake({ label: "not_interested", confidence: 0.92 });
    expect(await classify(ws, model)).toEqual([{ messageId: id, result: "classified", label: "not_interested" }]);
    expect(model.calls.map((c) => [c.kind, c.input.model])).toEqual([["reply", "m-ground"]]);
    expect(model.calls[0]!.input.messages[1]!.content).toMatch(/^<reply>\n[\s\S]*\n<\/reply>$/);

    const row = await event(id);
    expect(row).toMatchObject({ reply_label: "not_interested", reply_label_source: "ai", classification_status: "done", classification_model: "m-ground", classification_input_tokens: 300, classification_output_tokens: 10 });
    expect(Number(row.reply_label_confidence)).toBe(0.92);
    expect(Number(row.classification_cost_usd)).toBe(0.00034);
    expect(await leadRow(leadId)).toMatchObject({ agent_status: "stopped", agent_status_reason: "not_interested" });
    expect(await whatsappStatus(leadId)).toBe("reachable");
    expect(await tasks(leadId)).toEqual([{ title: "Not interested — review today", status: "open" }]);
    expect(await stopNotifications(leadId)).toEqual([]);

    const { MONTH_SPEND_SQL } = await import("../../src/services/agentRunner.service.js");
    expect(Number((await pool.query(`select ${MONTH_SPEND_SQL} as spent`, [ws])).rows[0].spent)).toBe(0.00034);
    const decisions = await pool.query(`select 1 from public.agent_decisions where workspace_id = $1`, [ws]);
    expect(decisions.rowCount).toBe(0);
    // Done: a later tick claims nothing.
    expect(await classify(ws, model)).toEqual([]);
  });

  it("positive stays handed_off with 'Wants to talk'; low confidence → other (4A title); low-confidence stop → stop", async () => {
    const a = await scenario();
    const idA = await inbound(a.ws, a.phone, secret("Can we talk tomorrow?"));
    await classify(a.ws, fake({ label: "positive", confidence: 0.8 }));
    expect((await event(idA)).reply_label).toBe("positive");
    expect(await leadRow(a.leadId)).toMatchObject({ agent_status: "handed_off" });
    expect(await tasks(a.leadId)).toEqual([{ title: "Wants to talk — respond today", status: "open" }]);

    // A later unclassified reply keeps the task's title; still one task.
    const idA2 = await inbound(a.ws, a.phone, secret("ok"));
    expect((await event(idA2)).classification_status).toBe("skipped"); // handed_off now: no AI step
    expect((await event(idA2)).reply_label).toBe("unclassified");
    expect(await tasks(a.leadId)).toEqual([{ title: "Wants to talk — respond today", status: "open" }]);

    const b = await scenario();
    const idB = await inbound(b.ws, b.phone, secret("Hmm, maybe"));
    await classify(b.ws, fake({ label: "positive", confidence: 0.4 }));
    expect(await event(idB)).toMatchObject({ reply_label: "other", reply_label_source: "ai" });
    expect(await tasks(b.leadId)).toEqual([{ title: DEFAULT_TITLE, status: "open" }]);

    const c = await scenario();
    const idC = await inbound(c.ws, c.phone, secret("bas karo yaar"));
    await classify(c.ws, fake({ label: "asked_to_stop", confidence: 0.3 }));
    expect((await event(idC)).reply_label).toBe("asked_to_stop");
    expect(await whatsappStatus(c.leadId)).toBe("opted_out");
    expect(await leadRow(c.leadId)).toMatchObject({ agent_status: "stopped", agent_status_reason: "asked_to_stop" });
  });

  it("model fails 3 times → unclassified (failed), no effects", async () => {
    const { ws, phone, leadId } = await scenario();
    const id = await inbound(ws, phone, secret("Tell me more about pricing"));
    const model = fake(new ModelOutputError("bad"), new ModelOutputError("bad"), new ModelOutputError("bad"));
    expect((await classify(ws, model)).map((o) => o.result)).toEqual(["retry"]);
    expect((await classify(ws, model)).map((o) => o.result)).toEqual(["retry"]);
    expect(await classify(ws, model)).toEqual([{ messageId: id, result: "failed", label: "unclassified" }]);
    expect(model.calls).toHaveLength(3);
    expect(await event(id)).toMatchObject({ reply_label: "unclassified", reply_label_source: "ai", classification_status: "failed", classification_attempts: 3 });
    expect(await leadRow(leadId)).toMatchObject({ agent_status: "handed_off" });
    expect(await tasks(leadId)).toEqual([{ title: DEFAULT_TITLE, status: "open" }]);
    expect(await classify(ws, model)).toEqual([]);
  });

  it("mode off → no AI step (unclassified); budget used up → unclassified, no call", async () => {
    const off = await scenario({ mode: "off" });
    const idOff = await inbound(off.ws, off.phone, secret("Interesting, send details"));
    expect(await event(idOff)).toMatchObject({ reply_label: "unclassified", reply_label_source: "keyword", classification_status: "skipped" });
    const model = fake({ label: "positive", confidence: 0.9 });
    expect(await classify(off.ws, model)).toEqual([]);

    const broke = await scenario({ budget: 0.01 });
    const spentId = await inbound(broke.ws, broke.phone, "not interested");
    await pool.query(`update public.whatsapp_inbound_events set classification_cost_usd = 1 where message_id = $1`, [spentId]);
    await pool.query(`update public.leads set agent_status = 'active', agent_status_reason = null where id = $1`, [broke.leadId]);
    const id = await inbound(broke.ws, broke.phone, secret("What does it cost?"));
    expect((await event(id)).classification_status).toBe("pending");
    expect(await classify(broke.ws, model)).toEqual([{ messageId: id, result: "skipped", label: "unclassified" }]);
    expect(await event(id)).toMatchObject({ reply_label: "unclassified", classification_status: "skipped" });
    expect(model.calls).toEqual([]);
  });

  it("the reply text never appears in logs, labels, notifications, tasks or the timeline", async () => {
    expect(secrets.length).toBeGreaterThan(5);
    const haystacks = [
      logged.join("\n"),
      JSON.stringify((await pool.query(`select title, detail from public.notifications where recipient_id = $1`, [owner.id])).rows),
      JSON.stringify((await pool.query(`select title from public.tasks where owner_id = $1`, [owner.id])).rows),
      JSON.stringify(
        (await pool.query(`select t.title, t.detail, t.metadata from public.timeline_events t join public.leads l on l.id = t.lead_id where l.owner_id = $1`, [owner.id])).rows,
      ),
      JSON.stringify(
        (await pool.query(
          `select reply_label, reply_label_source, classification_status, classification_model from public.whatsapp_inbound_events e join public.leads l on l.id = e.lead_id where l.owner_id = $1`,
          [owner.id],
        )).rows,
      ),
    ];
    for (const s of secrets) for (const h of haystacks) expect(h).not.toContain(s.slice(-14));
  });
});
