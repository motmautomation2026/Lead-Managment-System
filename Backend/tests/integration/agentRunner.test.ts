/**
 * Feature 3C-2: the SHADOW decision loop against a real database, with the
 * fake DecisionModel and fake embedder (never calls OpenAI). Claims only this
 * file's workspaces. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWorkspace, deleteCreatedTestWorkspaces, trackTestMember } from "../helpers/testWorkspaces.js";
import { Pool } from "pg";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import type { DecisionModel } from "../../src/providers/openai.provider.js";
import { ModelOutputError, PermanentProviderError } from "../../src/providers/provider-errors.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { fakeEmbedder } from "../helpers/fakeEmbedder.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const EMAIL: AgentDecision = {
  action: "send_email",
  subject: "Outbound for Acme Steel",
  body: "Hi Asha,\n\nFollowing up on our call about outbound for Acme Steel. Would a short call on Tuesday or Wednesday work for you?",
  assetIds: [],
  nextWakeInDays: 3,
  reasoning: "Follow up after the call.",
};
const TOO_LONG: AgentDecision = { ...EMAIL, body: `Hi Asha, ${"really ".repeat(300)}` };
const PRICES = { "m-decide": { inputPer1M: 2, outputPer1M: 8 }, "m-ground": { inputPer1M: 1, outputPer1M: 4 } };
const MODELS = { decision: "m-decide", grounding: "m-ground" };

describeIfDb("agent runner, shadow mode (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let adminId: string;
  const workspaces: string[] = [];

  // Outbound (linkedin) by default: an inbound first message must thank the lead (E2c), tested on its own below.
  // E3b-1: channels alternate from first_channel (default WhatsApp); email-first tests set it.
  async function scenario(
    settings: { mode?: string; monthly_budget_usd?: number; nurture_long_term?: boolean; playbook?: boolean; source?: string; firstChannel?: "email" | "whatsapp" } = {},
  ) {
    const ws = randomUUID();
    await createTestWorkspace(pool, "runner", { id: ws });
    workspaces.push(ws);
    if (settings.playbook !== false) {
      await pool.query(`insert into public.agent_playbooks (workspace_id, version, body, created_by_name) values ($1, 1, 'Be helpful.', 'Test')`, [ws]);
    }
    await pool.query(
      `update public.agent_settings
          set mode = $2, send_days = '{1,2,3,4,5,6,7}', send_window_start = '00:00', send_window_end = '23:59',
              monthly_budget_usd = $3, nurture_long_term = $4, current_playbook_version = $5, first_channel = $6
        where workspace_id = $1`,
      [ws, settings.mode ?? "shadow", settings.monthly_budget_usd ?? 100, settings.nurture_long_term ?? false, settings.playbook === false ? null : 1, settings.firstChannel ?? "whatsapp"],
    );
    const lead = await pool.query(
      `insert into public.leads (workspace_id, first_name, last_name, company, source, email, phone, phone_e164, owner_id, agent_status, pipeline_stage)
       values ($1, 'Asha', 'Rao', 'Acme Steel', $4, $2, '+919800000002', '+919800000002', $3, 'active', 'connected_qualifying') returning id`,
      [ws, `runner-${randomUUID()}@example.com`, adminId, settings.source ?? "linkedin"],
    );
    const leadId = lead.rows[0].id as string;
    const wakeupId = await wakeup(ws, leadId);
    return { ws, leadId, wakeupId };
  }

  async function wakeup(ws: string, leadId: string, extra: { status?: string; claimedAgo?: string; attempts?: number } = {}) {
    const result = await pool.query(
      `insert into public.agent_wakeups (workspace_id, lead_id, due_at, reason, status, claimed_at, attempt_count)
       values ($1, $2, now() - interval '1 minute', 'enrolled', $3, case when $4::text is null then null else now() - $4::interval end, $5) returning id`,
      [ws, leadId, extra.status ?? "pending", extra.claimedAgo ?? null, extra.attempts ?? 0],
    );
    return result.rows[0].id as string;
  }

  async function tick(ws: string, model: DecisionModel, overrides: { enabled?: boolean; prices?: Record<string, { inputPer1M: number; outputPer1M: number }> } = {}) {
    const { runAgentTick } = await import("../../src/services/agentRunner.service.js");
    return runAgentTick(overrides.enabled ?? true, { model, embedder: fakeEmbedder, prices: overrides.prices ?? PRICES, defaultModels: MODELS, workspaceIds: [ws] });
  }

  const decisions = async (leadId: string) => (await pool.query(`select * from public.agent_decisions where lead_id = $1 order by created_at`, [leadId])).rows;
  const wakeupRow = async (id: string) => (await pool.query(`select * from public.agent_wakeups where id = $1`, [id])).rows[0];
  const pendingFor = async (leadId: string) => (await pool.query(`select * from public.agent_wakeups where lead_id = $1 and status = 'pending'`, [leadId])).rows;
  const agentTimeline = async (leadId: string) =>
    (await pool.query(`select title, detail, actor_name, actor_source, event_kind from public.timeline_events where lead_id = $1 and title like 'AI %' order by occurred_at`, [leadId])).rows;
  const decideCalls = (model: ReturnType<typeof createFakeDecisionModel>) => model.calls.filter((c) => c.kind === "decide");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`runner-admin-${randomUUID()}@example.com`]);
    adminId = auth.rows[0].id;
    await pool.query(`update public.profiles set role = 'admin', is_active = true, full_name = 'Runner Admin' where id = $1`, [adminId]);
    await trackTestMember(pool, adminId, "admin");
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await pool.query(`delete from public.notifications where workspace_id = any($1::uuid[])`, [workspaces]).catch(() => undefined);
    await pool.query(`delete from auth.users where id = $1`, [adminId]).catch((error: Error) => console.warn(`[agentRunner] user cleanup failed: ${error.message}`));
    await pool.end();
  });

  it("happy path: one draft row with tokens and cost, a timer at next_wake_at, a timeline row, the wakeup done; nothing sent", async () => {
    const { ws, leadId, wakeupId } = await scenario({ firstChannel: "email" });
    const model = createFakeDecisionModel({ decisions: [EMAIL] });
    const before = Date.now();
    expect(await tick(ws, model)).toEqual([{ wakeupId, leadId, result: "draft", action: "send_email" }]);

    const [row, ...more] = await decisions(leadId);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      mode: "shadow",
      outcome: "draft",
      action: "send_email",
      message_subject: EMAIL.action === "send_email" ? EMAIL.subject : null,
      regenerated: false,
      playbook_version: 1,
      decision_model: "m-decide",
      grounding_model: "m-ground",
      input_tokens: 2000,
      output_tokens: 400,
      wakeup_id: wakeupId,
    });
    expect(Number(row.cost_usd)).toBe(0.0054);
    expect(row.rules_result.allowed).toBe(true);
    expect(row.grounding_result).toEqual({ supported: true, unsupportedClaims: [] });
    expect(row.send_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(row.next_wake_at.getTime() - row.send_at.getTime()).toBe(3 * DAY);
    expect(model.calls.map((c) => c.kind)).toEqual(["decide", "grounding"]);

    const [timer] = await pendingFor(leadId);
    expect(timer).toMatchObject({ reason: "timer" });
    expect(timer.due_at.getTime()).toBe(row.next_wake_at.getTime());
    expect(await wakeupRow(wakeupId)).toMatchObject({ status: "done", attempt_count: 1 });
    expect(await agentTimeline(leadId)).toEqual([
      { title: "AI drafted email: Outbound for Acme Steel", detail: "Shadow mode — not sent", actor_name: "AI Agent", actor_source: "automation", event_kind: "automation" },
    ]);
    const lead = (await pool.query(`select agent_status, agent_touch_count, agent_last_touch_at, pipeline_stage from public.leads where id = $1`, [leadId])).rows[0];
    expect(lead).toEqual({ agent_status: "active", agent_touch_count: 0, agent_last_touch_at: null, pipeline_stage: "connected_qualifying" });

    // A second wakeup soon after: the shadow draft counts as a touch, so the 48 h gap applies.
    // E3b-1: channels alternate, so the second message is a WhatsApp.
    await pool.query(`update public.agent_wakeups set due_at = now() - interval '1 minute' where id = $1`, [timer.id]);
    await tick(ws, createFakeDecisionModel({ decisions: [{ action: "send_whatsapp", body: "Hi Asha, would a short call on Thursday or Friday suit you?", assetIds: [], nextWakeInDays: 3, reasoning: "Follow up." }] }));
    const [first, second] = await decisions(leadId);
    expect(second.action).toBe("send_whatsapp");
    expect(second.send_at.getTime() - first.send_at.getTime()).toBeGreaterThanOrEqual(48 * HOUR - MIN);
  });

  it("a rules violation is regenerated once, then succeeds", async () => {
    const { ws, leadId } = await scenario({ firstChannel: "email" });
    const model = createFakeDecisionModel({ decisions: [TOO_LONG, EMAIL] });
    await tick(ws, model);
    const [row] = await decisions(leadId);
    expect(row).toMatchObject({ outcome: "draft", action: "send_email", regenerated: true, input_tokens: 3000, output_tokens: 600 });
    expect(decideCalls(model)).toHaveLength(2);
    expect(decideCalls(model)[1]!.input.messages[1]!.content).toContain("Your previous decision was rejected for these reasons:\n- length: ");
  });

  it("failures record a handoff draft keeping the failed message, with regenerated=true (a fixable problem gets two regenerations, E2f)", async () => {
    const { ws, leadId } = await scenario({ firstChannel: "email" });
    const model = createFakeDecisionModel({ decisions: [TOO_LONG, TOO_LONG] });
    expect((await tick(ws, model))[0]).toMatchObject({ result: "draft", action: "handoff" });
    const [row] = await decisions(leadId);
    expect(row).toMatchObject({
      outcome: "draft",
      action: "handoff",
      handoff_title: "AI couldn't write a message that meets the playbook",
      handoff_urgency: "normal",
      regenerated: true,
      message_subject: "Outbound for Acme Steel",
      send_at: null,
      next_wake_at: null,
    });
    expect(row.message_body).toContain("really really");
    expect(row.rules_result.allowed).toBe(false);
    // E2b: every attempt's failures are recorded for AI Activity; E2f: a too-long message (fixable) gets a second regeneration.
    expect(decideCalls(model)).toHaveLength(3);
    expect(row.quality_checks).toHaveLength(3);
    expect(row.quality_checks[0].problems[0]).toMatch(/^length: /);
    expect(await pendingFor(leadId)).toEqual([]);
    expect((await agentTimeline(leadId)).map((t) => t.title)).toEqual(["AI suggested handoff: AI couldn't write a message that meets the playbook"]);
  });

  it("grounding supported=false is regenerated with the unsupported claims", async () => {
    const { ws, leadId } = await scenario({ firstChannel: "email" });
    const model = createFakeDecisionModel({
      decisions: [EMAIL],
      grounding: [{ supported: false, unsupportedClaims: ["200 clients"] }, { supported: true, unsupportedClaims: [] }],
    });
    await tick(ws, model);
    const [row] = await decisions(leadId);
    expect(row).toMatchObject({ outcome: "draft", action: "send_email", regenerated: true, grounding_result: { supported: true, unsupportedClaims: [] } });
    expect(decideCalls(model)[1]!.input.messages[1]!.content).toContain("- Unsupported claim: 200 clients");
  });

  it("a precheck block makes no model call and no decision row", async () => {
    const { ws, leadId, wakeupId } = await scenario({ nurture_long_term: true });
    await pool.query(`update public.leads set lifecycle_state = 'long_term_nurture' where id = $1`, [leadId]);
    await pool.query(`update public.agent_settings set nurture_long_term = false where workspace_id = $1`, [ws]);
    const model = createFakeDecisionModel();
    expect((await tick(ws, model))[0]).toMatchObject({ result: "precheck" });
    expect(model.calls).toEqual([]);
    expect(await decisions(leadId)).toEqual([]);
    expect(await wakeupRow(wakeupId)).toMatchObject({ status: "done" });
  });

  it("mode off: nothing is claimed", async () => {
    const { ws, wakeupId } = await scenario({ mode: "off" });
    const model = createFakeDecisionModel();
    expect(await tick(ws, model)).toEqual([]);
    expect(await wakeupRow(wakeupId)).toMatchObject({ status: "pending", attempt_count: 0 });
  });

  it("AGENT_RUNNER_ENABLED unset: nothing runs (and the worker default is off)", async () => {
    const { ws, wakeupId } = await scenario();
    const model = createFakeDecisionModel();
    expect(await tick(ws, model, { enabled: false })).toEqual([]);
    expect(await wakeupRow(wakeupId)).toMatchObject({ status: "pending" });
    // The switch defaults to off, and only exactly "true" turns it on.
    const { loadWorkerEnv } = await import("../../src/workerEnv.js");
    expect(loadWorkerEnv({}).AGENT_RUNNER_ENABLED).toBe(false);
    for (const value of ["", "false", "TRUE", "1", "yes"]) expect(loadWorkerEnv({ AGENT_RUNNER_ENABLED: value }).AGENT_RUNNER_ENABLED).toBe(false);
    expect(loadWorkerEnv({ AGENT_RUNNER_ENABLED: "true" }).AGENT_RUNNER_ENABLED).toBe(true);
  });

  it("budget reached: no model call, the wakeup deferred an hour, exactly one admin notification over two ticks", async () => {
    const { ws, leadId, wakeupId } = await scenario({ monthly_budget_usd: 1 });
    await pool.query(`insert into public.agent_decisions (workspace_id, lead_id, mode, action, cost_usd, outcome) values ($1, $2, 'shadow', 'wait', 2, 'draft')`, [ws, leadId]);
    const model = createFakeDecisionModel();
    const before = Date.now();
    expect((await tick(ws, model))[0]).toMatchObject({ result: "deferred" });
    const deferred = await wakeupRow(wakeupId);
    expect(deferred).toMatchObject({ status: "pending", attempt_count: 0 });
    expect(deferred.due_at.getTime()).toBeGreaterThanOrEqual(before + HOUR - MIN);

    await pool.query(`update public.agent_wakeups set due_at = now() - interval '1 minute' where id = $1`, [wakeupId]);
    expect((await tick(ws, model))[0]).toMatchObject({ result: "deferred" });
    expect(model.calls).toEqual([]);
    const notes = await pool.query(`select title, kind, href from public.notifications where workspace_id = $1 and recipient_id = $2`, [ws, adminId]);
    expect(notes.rows).toEqual([{ title: "AI agent paused: monthly budget reached", kind: "warning", href: "/settings" }]);
    const settings = await pool.query(`select budget_alerted_month from public.agent_settings where workspace_id = $1`, [ws]);
    expect(settings.rows[0].budget_alerted_month).not.toBeNull();
  });

  it("daily decision cap reached: no model call, deferred to the next IST midnight + 5 min, one admin notification over two ticks", async () => {
    const { ws, leadId, wakeupId } = await scenario();
    await pool.query(`update public.agent_settings set max_decisions_per_day = 2 where workspace_id = $1`, [ws]);
    await pool.query(
      `insert into public.agent_decisions (workspace_id, lead_id, mode, action, cost_usd, outcome) values ($1, $2, 'shadow', 'wait', 0, 'draft'), ($1, $2, 'shadow', 'wait', 0, 'draft')`,
      [ws, leadId],
    );
    const model = createFakeDecisionModel();
    expect((await tick(ws, model))[0]).toMatchObject({ result: "deferred" });
    const deferred = await wakeupRow(wakeupId);
    expect(deferred).toMatchObject({ status: "pending", attempt_count: 0 });
    // IST is a fixed UTC+05:30.
    const IST_OFFSET = 330 * MIN;
    const DAY = 24 * HOUR;
    const nextIstMidnight = Math.floor((Date.now() + IST_OFFSET) / DAY) * DAY + DAY - IST_OFFSET;
    expect(deferred.due_at.getTime()).toBe(nextIstMidnight + 5 * MIN);

    await pool.query(`update public.agent_wakeups set due_at = now() - interval '1 minute' where id = $1`, [wakeupId]);
    expect((await tick(ws, model))[0]).toMatchObject({ result: "deferred" });
    expect(model.calls).toEqual([]);
    const notes = await pool.query(`select title, kind, href from public.notifications where workspace_id = $1 and recipient_id = $2`, [ws, adminId]);
    expect(notes.rows).toEqual([{ title: "AI agent paused for today: daily decision limit reached", kind: "warning", href: "/settings" }]);
    const settings = await pool.query(`select daily_cap_alerted_on from public.agent_settings where workspace_id = $1`, [ws]);
    expect(settings.rows[0].daily_cap_alerted_on).not.toBeNull();
  });

  it("a missing price defers 10 minutes without burning an attempt; so does a missing playbook (1 h)", async () => {
    const priced = await scenario();
    const model = createFakeDecisionModel();
    const before = Date.now();
    expect((await tick(priced.ws, model, { prices: { "m-decide": PRICES["m-decide"] } }))[0]).toMatchObject({ result: "deferred" });
    const row = await wakeupRow(priced.wakeupId);
    expect(row).toMatchObject({ status: "pending", attempt_count: 0 });
    expect(row.due_at.getTime()).toBeGreaterThanOrEqual(before + 10 * MIN - MIN);

    const noPlaybook = await scenario({ playbook: false });
    expect((await tick(noPlaybook.ws, model))[0]).toMatchObject({ result: "deferred" });
    expect((await wakeupRow(noPlaybook.wakeupId)).due_at.getTime()).toBeGreaterThanOrEqual(before + HOUR - MIN);
    expect(model.calls).toEqual([]);
  });

  it("a stale executing wakeup is reclaimed and processed", async () => {
    const { ws, leadId, wakeupId } = await scenario();
    await pool.query(`update public.agent_wakeups set status = 'cancelled' where id = $1`, [wakeupId]);
    const stale = await wakeup(ws, leadId, { status: "executing", claimedAgo: "20 minutes", attempts: 1 });
    const model = createFakeDecisionModel({ decisions: [EMAIL] });
    expect((await tick(ws, model))[0]).toMatchObject({ wakeupId: stale, result: "draft" });
    expect(await wakeupRow(stale)).toMatchObject({ status: "done", attempt_count: 2 });
  });

  it("claims at most one wakeup per lead: a stale executing row and a due pending one → only the earliest", async () => {
    const { ws, leadId, wakeupId: pending } = await scenario({ firstChannel: "email" });
    const stale = await wakeup(ws, leadId, { status: "executing", claimedAgo: "20 minutes", attempts: 1 });
    // The stale row is the earlier one.
    await pool.query(`update public.agent_wakeups set due_at = now() - interval '1 hour' where id = $1`, [stale]);
    const model = createFakeDecisionModel({ decisions: [EMAIL] });
    const outcomes = await tick(ws, model);
    expect(outcomes.map((o) => o.wakeupId)).toEqual([stale]);
    expect(decideCalls(model)).toHaveLength(1);
    expect(await wakeupRow(stale)).toMatchObject({ status: "done" });
    // The pending one was left for a later tick (it merged with the new timer, keeping the earlier due time).
    expect(await wakeupRow(pending)).toMatchObject({ status: "pending", attempt_count: 0 });

    // While a fresh executing row exists for the lead, nothing else is claimed for it.
    const busy = await wakeup(ws, leadId, { status: "executing", claimedAgo: "1 minute", attempts: 1 });
    await pool.query(`update public.agent_wakeups set due_at = now() - interval '1 minute' where id = $1`, [pending]);
    expect(await tick(ws, model)).toEqual([]);
    expect(await wakeupRow(pending)).toMatchObject({ status: "pending" });
    await pool.query(`update public.agent_wakeups set status = 'cancelled' where id = $1`, [busy]);
  });

  it("an event wakeup arriving during processing merges with the new timer", async () => {
    const { ws, leadId } = await scenario({ firstChannel: "email" });
    const { enqueueWakeup } = await import("../../src/services/agentWakeups.service.js");
    const fake = createFakeDecisionModel({ decisions: [EMAIL] });
    const eventDue = new Date(Date.now() + HOUR);
    const model: DecisionModel = {
      async decide(input) {
        expect(await enqueueWakeup(pool, { workspaceId: ws, leadId, reason: "call_logged", dueAt: eventDue })).toBe("inserted");
        return fake.decide(input);
      },
      checkGrounding: (input) => fake.checkGrounding(input),
    };
    await tick(ws, model);
    const [merged, ...others] = await pendingFor(leadId);
    expect(others).toEqual([]);
    expect(merged.reason).toBe("call_logged");
    expect(merged.due_at.getTime()).toBe(eventDue.getTime());
    expect(merged.payload.events.map((e: { reason: string }) => e.reason)).toEqual(["call_logged", "timer"]);
  });

  it("D1: a decision records the company and open deal it saw; review detail and the lead panel return them", async () => {
    const { ws, leadId, wakeupId } = await scenario({ firstChannel: "email" });
    const company = (
      await pool.query(
        `insert into public.companies (workspace_id, name, normalized_name, city, description) values ($1, 'Acme Steel Pvt Ltd', 'acme steel', 'Pune', 'Family-owned mill.') returning id`,
        [ws],
      )
    ).rows[0].id as string;
    await pool.query(`update public.leads set company_id = $2 where id = $1`, [leadId, company]);
    const deal = (
      await pool.query(
        `insert into public.deals (workspace_id, name, lead_id, company_id, stage, amount, source) values ($1, 'Acme – pilot', $2, $3, 'proposal_sent', 4242421, 'manual') returning id`,
        [ws, leadId, company],
      )
    ).rows[0].id as string;

    const model = createFakeDecisionModel({ decisions: [EMAIL] });
    expect(await tick(ws, model)).toEqual([{ wakeupId, leadId, result: "draft", action: "send_email" }]);
    const prompt = decideCalls(model)[0]!.input.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("- Name: Acme Steel Pvt Ltd");
    expect(prompt).toContain("Company description: Family-owned mill.");
    expect(prompt).toContain("Open deal: Acme – pilot");
    expect(prompt).not.toContain("4242421");
    const grounding = model.calls.find((c) => c.kind === "grounding")!.input.messages.map((m) => m.content).join("\n");
    expect(grounding).toContain("- Location: Pune");
    expect(grounding).not.toContain("Family-owned");

    const [row] = await decisions(leadId);
    expect(row).toMatchObject({ outcome: "draft", context_company_id: company, context_deal_id: deal, context_deal_stage: "proposal_sent" });

    // The deal moves on later: the decision keeps the stage it saw.
    await pool.query(`update public.deals set stage = 'negotiation' where id = $1`, [deal]);
    const { getDecision, getLeadAgentPanel } = await import("../../src/services/agentReview.service.js");
    const expected = { company: { id: company, name: "Acme Steel Pvt Ltd" }, deal: { id: deal, name: "Acme – pilot", stage: "proposal_sent" } };
    expect((await getDecision(pool, ws, row.id)).context).toEqual(expected);
    expect((await getLeadAgentPanel(pool, ws, leadId)).decisions[0]).toMatchObject({ id: row.id, context: expected });
  });

  it("D1: without a company or open deal the context columns stay null", async () => {
    const { ws, leadId } = await scenario();
    await tick(ws, createFakeDecisionModel({ decisions: [EMAIL] }));
    const [row] = await decisions(leadId);
    expect(row).toMatchObject({ outcome: "draft", context_company_id: null, context_deal_id: null, context_deal_stage: null });
    const { getDecision } = await import("../../src/services/agentReview.service.js");
    expect((await getDecision(pool, ws, row.id)).context).toEqual({ company: null, deal: null });
  });

  it("model output errors burn attempts and fail after 3; a permanent error fails at once", async () => {
    const { ws, leadId, wakeupId } = await scenario();
    const model = createFakeDecisionModel({ decisions: [new ModelOutputError("The model's invalid JSON.")] });
    expect((await tick(ws, model))[0]).toMatchObject({ result: "deferred" });
    expect(await wakeupRow(wakeupId)).toMatchObject({ status: "pending", attempt_count: 1 });
    await pool.query(`update public.agent_wakeups set due_at = now() - interval '1 minute', attempt_count = 2 where id = $1`, [wakeupId]);
    expect((await tick(ws, model))[0]).toMatchObject({ result: "failed" });
    const [failed] = await decisions(leadId);
    expect(failed).toMatchObject({ outcome: "failed", message_body: null, message_subject: null });
    expect(failed.error).toContain("ModelOutputError");
    expect(await wakeupRow(wakeupId)).toMatchObject({ status: "done", attempt_count: 3 });

    const other = await scenario();
    const quota = createFakeDecisionModel({ decisions: [new PermanentProviderError("OpenAI quota exceeded: no credit")] });
    expect((await tick(other.ws, quota))[0]).toMatchObject({ result: "failed" });
    expect((await decisions(other.leadId))[0]).toMatchObject({ outcome: "failed" });
  });

  it("handoff, stop and update_stage are only drafts: no tasks, sends, stage or status changes, workflows untouched", async () => {
    const { ws, leadId, wakeupId } = await scenario();
    const before = (await pool.query(`select pipeline_stage, agent_status, automation_mode, lifecycle_state from public.leads where id = $1`, [leadId])).rows[0];
    const steps: AgentDecision[] = [
      { action: "handoff", title: "Call Asha about budget", urgency: "high", reasoning: "Asked for a call." },
      { action: "stop", reason: "not_a_fit", moveToLongTermNurture: true, reasoning: "Wrong industry." },
      { action: "update_stage", newStage: "meeting_scheduling", reasoning: "Wants a meeting." },
    ];
    await pool.query(`update public.agent_wakeups set status = 'cancelled' where id = $1`, [wakeupId]);
    for (const step of steps) {
      await wakeup(ws, leadId);
      await tick(ws, createFakeDecisionModel({ decisions: [step] }));
    }
    expect((await decisions(leadId)).map((d) => [d.action, d.outcome])).toEqual([
      ["handoff", "draft"],
      ["stop", "draft"],
      ["update_stage", "draft"],
    ]);
    expect((await agentTimeline(leadId)).map((t) => t.title)).toEqual([
      "AI suggested handoff: Call Asha about budget",
      "AI suggested stopping: not a fit",
      "AI suggested stage: meeting scheduling",
    ]);
    expect(await pendingFor(leadId)).toEqual([]);
    const after = (await pool.query(`select pipeline_stage, agent_status, automation_mode, lifecycle_state from public.leads where id = $1`, [leadId])).rows[0];
    expect(after).toEqual(before);
    const counts = await pool.query(
      `select (select count(*)::int from public.tasks where lead_id = $1) as tasks,
              (select count(*)::int from public.whatsapp_outbound_messages where workspace_id = $2) as whatsapp,
              (select count(*)::int from public.workflow_runs where lead_id = $1) as runs`,
      [leadId, ws],
    );
    expect(counts.rows[0]).toEqual({ tasks: 0, whatsapp: 0, runs: 0 });
  });

  describe("E2f: signals, negated banned phrases, regenerations", () => {
    const whatsapp = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });
    const note = (leadId: string, text: string) =>
      pool.query(
        `insert into public.timeline_events (lead_id, event_kind, title, detail, actor_name, actor_source, occurred_at)
         values ($1, 'note', 'Note added', $2, 'Rep', 'manual', now() - interval '3 days')`,
        [leadId, text],
      );

    it("a price question in the latest note turns a send into the handoff 'Lead asked about price', without a regeneration", async () => {
      const { ws, leadId } = await scenario();
      await note(leadId, "Manoj replied to our email asking: what are your charges?");
      const model = createFakeDecisionModel({ decisions: [whatsapp("Hi Asha, our charges depend on the scope of work.")] });
      expect((await tick(ws, model))[0]).toMatchObject({ result: "draft", action: "handoff" });
      const [row] = await decisions(leadId);
      expect(row).toMatchObject({ outcome: "draft", action: "handoff", handoff_title: "Lead asked about price", regenerated: false });
      expect(row.rules_result.adjustments).toContainEqual({ rule: "signal", message: "Lead asked about price: handing off instead of sending." });
      expect(row.quality_checks).toMatchObject([{ problems: [] }]);
      expect(model.calls.map((c) => c.kind)).toEqual(["decide"]);
      expect(decideCalls(model)[0]!.input.messages[1]!.content).toContain("Signal: the contact asked about price — hand off.");
    });

    it("a consumer business enquiry turns a send into stop (not a fit)", async () => {
      const { ws, leadId } = await scenario({ source: "website" });
      await pool.query(
        `insert into public.timeline_events (lead_id, event_kind, title, detail, actor_name, actor_source, metadata)
         values ($1, 'system', 'Website form submission', 'form', 'System', 'system', $2)`,
        [leadId, { channel: "website_form", rawMessage: "We run a bakery and cafe in Bandra. We want more walk-in customers on weekdays." }],
      );
      await tick(ws, createFakeDecisionModel({ decisions: [whatsapp("Hello Asha, thank you for contacting us. Would a short call on Thursday or Friday suit you?")] }));
      const [row] = await decisions(leadId);
      expect(row).toMatchObject({ action: "stop", stop_reason: "not_a_fit", regenerated: false });
      expect(row.reasoning).toMatch(/^Not a B2B business\./);
    });

    it("\"we cannot guarantee\" passes the banned-phrase check; \"guaranteed results\" is regenerated", async () => {
      const honest = whatsapp("Hi Asha, we cannot guarantee orders, but we can show you how we find buyers. Would Tuesday or Wednesday suit you for a call?");
      const { ws, leadId } = await scenario();
      await tick(ws, createFakeDecisionModel({ decisions: [honest] }));
      expect((await decisions(leadId))[0]).toMatchObject({ action: "send_whatsapp", regenerated: false });

      const other = await scenario();
      await tick(other.ws, createFakeDecisionModel({ decisions: [whatsapp("Hi Asha, we offer guaranteed results. Would Tuesday suit you?"), honest] }));
      const [row] = await decisions(other.leadId);
      expect(row).toMatchObject({ action: "send_whatsapp", regenerated: true });
      expect(row.quality_checks[0].problems).toEqual(['banned_phrase: Uses banned phrase(s): "guaranteed".']);
    });

    it("two questions twice, then one → accepted on the third attempt, all three recorded", async () => {
      const { ws, leadId } = await scenario();
      const two = whatsapp("Hi Asha, is Tuesday good? Or Wednesday?");
      const model = createFakeDecisionModel({ decisions: [two, two, whatsapp("Hi Asha, would Tuesday or Wednesday suit you for a short call?")] });
      await tick(ws, model);
      const [row] = await decisions(leadId);
      expect(row).toMatchObject({ action: "send_whatsapp", regenerated: true });
      expect(row.quality_checks.map((q: { problems: string[] }) => q.problems.length)).toEqual([1, 1, 0]);
      expect(decideCalls(model)).toHaveLength(3);
    });
  });

  describe("E2c: message checks in code", () => {
    const whatsapp = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });

    it("an inbound first message that thanks the lead is accepted (Suyash); one without thanks is regenerated", async () => {
      const { ws, leadId } = await scenario({ source: "website" });
      const thanks = whatsapp("Hello Asha, thank you for contacting Northbeam. We focus on relevant business opportunities. Would a short introductory call on Thursday or Friday suit you?");
      const model = createFakeDecisionModel({ decisions: [thanks] });
      expect((await tick(ws, model))[0]).toMatchObject({ result: "draft", action: "send_whatsapp" });
      const [row] = await decisions(leadId);
      expect(row).toMatchObject({ action: "send_whatsapp", regenerated: false });
      expect(row.rules_result.allowed).toBe(true);
      const prompt = decideCalls(model)[0]!.input.messages[1]!.content;
      expect(prompt).toContain("Conversation so far: none yet.");
      // The model no longer judges the thanks rule.
      expect(model.calls.find((c) => c.kind === "grounding")!.input.messages[0]!.content).not.toContain("not_thanking_inbound");

      const other = await scenario({ source: "website" });
      const noThanks = createFakeDecisionModel({ decisions: [whatsapp("Hello Asha, hope you are well. Would a short call on Thursday or Friday suit you?"), thanks] });
      await tick(other.ws, noThanks);
      const [retried] = await decisions(other.leadId);
      expect(retried).toMatchObject({ action: "send_whatsapp", regenerated: true });
      expect(retried.quality_checks[0].problems[0]).toMatch(/^not_thanking_inbound: /);
      expect(decideCalls(noThanks)).toHaveLength(2);
    });

    it("with a logged note, an introduction is regenerated, then accepted; twice → handoff", async () => {
      const intro = whatsapp("Hi Asha, thank you for reaching out. Could we set up an introductory call on Thursday or Friday?");
      const followUp = whatsapp("Hi Asha, following your note about outbound for Acme Steel, would Tuesday or Wednesday suit you for a call?");
      const { ws, leadId } = await scenario();
      await pool.query(`insert into public.lead_notes (lead_id, author_name, body, created_at) values ($1, 'Rep', 'Interested in outbound.', now() - interval '3 days')`, [leadId]);
      const model = createFakeDecisionModel({ decisions: [intro, followUp] });
      await tick(ws, model);
      const [row] = await decisions(leadId);
      expect(row).toMatchObject({ action: "send_whatsapp", regenerated: true, message_body: followUp.action === "send_whatsapp" ? followUp.body : null });
      expect(row.quality_checks[0].problems[0]).toMatch(/^introduction_mid_conversation: /);
      expect(decideCalls(model)[0]!.input.messages[1]!.content).toContain("Conversation so far: you are already in discussion with this contact");

      const other = await scenario();
      await pool.query(`insert into public.lead_notes (lead_id, author_name, body, created_at) values ($1, 'Rep', 'Interested.', now() - interval '3 days')`, [other.leadId]);
      await tick(other.ws, createFakeDecisionModel({ decisions: [intro, intro] }));
      const [handoff] = await decisions(other.leadId);
      expect(handoff).toMatchObject({ action: "handoff", handoff_title: "AI couldn't write a message that meets the playbook" });
    });

    it("repeating 4+ words of the internal company description → internal_info_leak → regenerated; still leaking → handoff", async () => {
      const leak = whatsapp("Hi Asha, we support firms in specialty chemicals for textile plants. Would Tuesday or Wednesday suit you for a call?");
      const clean = whatsapp("Hi Asha, would Tuesday or Wednesday suit you for a short call about outbound for Acme Steel?");
      const withCompany = async () => {
        const s = await scenario();
        const company = (
          await pool.query(
            `insert into public.companies (workspace_id, name, normalized_name, description) values ($1, 'Acme Steel', 'acme steel', 'Supplier of specialty chemicals for textile plants in Gujarat.') returning id`,
            [s.ws],
          )
        ).rows[0].id as string;
        await pool.query(`update public.leads set company_id = $2 where id = $1`, [s.leadId, company]);
        return s;
      };
      const first = await withCompany();
      const model = createFakeDecisionModel({ decisions: [leak, clean] });
      await tick(first.ws, model);
      const [row] = await decisions(first.leadId);
      expect(row).toMatchObject({ action: "send_whatsapp", regenerated: true });
      expect(row.quality_checks[0].problems[0]).toBe('internal_info_leak: Repeats internal information. Do not mention: "specialty chemicals for textile plants".');
      expect(decideCalls(model)[1]!.input.messages[1]!.content).toContain('Do not mention: "specialty chemicals for textile plants"');

      const second = await withCompany();
      await tick(second.ws, createFakeDecisionModel({ decisions: [leak, leak] }));
      const [handoff] = await decisions(second.leadId);
      // A leak is a safety problem, not a playbook one.
      expect(handoff).toMatchObject({ action: "handoff", handoff_title: "AI couldn't write a safe message" });
      expect(handoff.quality_checks[1].problems.some((p: string) => p.startsWith("internal_info_leak: "))).toBe(true);
    });
  });
});
