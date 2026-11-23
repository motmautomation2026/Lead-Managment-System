/**
 * SUM-1: lead summary card. The worker step runs runLeadSummaries with the fake model (never OpenAI); nothing is sent.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const PRICES = { "m-sum": { inputPer1M: 0.2, cachedInputPer1M: 0.02, outputPer1M: 1.25 } };
const SUMMARY = { requirement: "Export sales calling", soFar: ["20 Nov: call connected"], status: "Active, warm", nextStep: "No next step" };

describeIfDb("Lead summary (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let owner: Actor;
  let otherRep: Actor;
  let outsider: Actor;
  const logged: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "lead-summary");
    owner = await api.newUser("salesperson", { name: "SUM1 Owner" });
    otherRep = await api.newUser("salesperson", { name: "SUM1 Other" });
    outsider = await api.newUser("salesperson", { name: "SUM1 Outsider", member: false });
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  async function scenario(opts: { automated?: boolean; cap?: number; mode?: string } = {}) {
    const ws = await createTestWorkspace(pool, "lead-summary");
    await pool.query(`update public.agent_settings set mode = $2, monthly_budget_usd = 100, summary_daily_cap = $3 where workspace_id = $1`, [ws, opts.mode ?? "shadow", opts.cap ?? 200]);
    const lead = await pool.query(
      `insert into public.leads (workspace_id, first_name, last_name, company, source, email, owner_id, service_interest, automation_enabled)
       values ($1, 'Asha', 'Rao', 'Acme Steel', 'referral', $2, $3, 'Sales outsourcing', $4) returning id`,
      [ws, `sum1-${randomUUID()}@example.com`, owner.id, opts.automated ?? true],
    );
    return { ws, leadId: lead.rows[0].id as string };
  }

  const event = (leadId: string, title: string, kind = "note", detail: string | null = null) =>
    pool.query(`insert into public.timeline_events (lead_id, event_kind, title, detail, actor_name, actor_source) values ($1, $2, $3, $4, 'Test', 'manual')`, [leadId, kind, title, detail]);
  /** Skips the 2-minute debounce / 10-minute gap without waiting. */
  const makeDue = (leadId: string, generatedMinutesAgo?: number) =>
    pool.query(
      `update public.lead_summaries set due_at = now() - interval '1 second'${generatedMinutesAgo === undefined ? "" : `, generated_at = now() - $2 * interval '1 minute'`} where lead_id = $1`,
      generatedMinutesAgo === undefined ? [leadId] : [leadId, generatedMinutesAgo],
    );
  const run = async (ws: string, model = createFakeDecisionModel({ summaries: [SUMMARY], tokens: { input: 900, output: 120 } })) => {
    const { runLeadSummaries } = await import("../../src/services/leadSummary.service.js");
    return { outcomes: await runLeadSummaries(true, { model, prices: PRICES, summaryModel: "m-sum", workspaceIds: [ws] }), model };
  };
  const row = async (leadId: string) => (await pool.query(`select * from public.lead_summaries where lead_id = $1`, [leadId])).rows[0];

  it("a call on an automated lead queues it after the debounce (a note or sent message doesn't); once per 10 min; unchanged inputs skip the model; cost counted", async () => {
    const { ws, leadId } = await scenario();
    await event(leadId, "Note Added", "note", "Wants pricing for export calling");
    await event(leadId, "AI sent WhatsApp", "automation");
    expect(await row(leadId)).toMatchObject({ due_at: null });
    await event(leadId, "Call Connected - interested", "call", "Wants pricing for export calling");
    const queued = await row(leadId);
    expect(new Date(queued.due_at).getTime()).toBeGreaterThan(Date.now() + 60_000); // debounce
    expect((await run(ws)).outcomes).toEqual([]);

    await makeDue(leadId);
    const first = await run(ws);
    expect(first.outcomes).toEqual([{ leadId, result: "generated" }]);
    expect(first.model.calls[0]!.input).toMatchObject({ model: "m-sum", maxCompletionTokens: 150 });
    expect(await row(leadId)).toMatchObject({ status: "ready", summary: SUMMARY, due_at: null, model: "m-sum" });
    const runs = await pool.query(`select model, input_tokens, output_tokens, cost_usd from public.lead_summary_runs where lead_id = $1`, [leadId]);
    expect(runs.rows).toEqual([{ model: "m-sum", input_tokens: 900, output_tokens: 120, cost_usd: "0.000330" }]);
    const { MONTH_SPEND_SQL } = await import("../../src/services/agentRunner.service.js");
    expect(Number((await pool.query(`select ${MONTH_SPEND_SQL} as s`, [ws])).rows[0].s)).toBeCloseTo(0.00033, 6);

    // New activity within 10 minutes of the last summary: not claimed even when due.
    await event(leadId, "Call Not Connected (attempt 1)", "call", "no_answer");
    await makeDue(leadId);
    expect((await run(ws)).outcomes).toEqual([]);

    // Past the 10-minute gap: the call changed the inputs → a new summary.
    await makeDue(leadId, 11);
    expect((await run(ws)).outcomes).toEqual([{ leadId, result: "generated" }]);
    // An event outside the summary's inputs (system, not a lifecycle title): hash unchanged → no model call.
    await event(leadId, "Owner reassigned", "system");
    await makeDue(leadId, 11);
    const third = await run(ws);
    expect(third.outcomes).toEqual([{ leadId, result: "unchanged" }]);
    expect(third.model.calls).toEqual([]);
    // The summary text is never logged.
    expect(logged.join("\n")).not.toContain(SUMMARY.requirement);
  });

  it("an old (not automated) lead is summarised only when someone opens it", async () => {
    const { ws, leadId } = await scenario({ automated: false });
    await event(leadId, "Call Connected - interested", "call");
    await makeDue(leadId);
    expect((await run(ws)).outcomes).toEqual([]);
    expect((await row(leadId)).due_at).toBeNull(); // pruned

    const card = await api.call(owner, ws, "GET", `/leads/${leadId}/summary`);
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ ai: { summary: null, pending: true }, canRefresh: true, quickFacts: { requirement: "Sales outsourcing", nextStep: null } });
    expect((await run(ws)).outcomes).toEqual([{ leadId, result: "generated" }]);
    const after = await api.call(owner, ws, "GET", `/leads/${leadId}/summary`);
    expect(after.body.ai).toMatchObject({ summary: SUMMARY, status: "ready", pending: false });
  });

  it("the daily cap stops AI summaries (quick facts stay); agent off → no AI", async () => {
    const capped = await scenario({ cap: 0 });
    await event(capped.leadId, "Replied by email", "email");
    expect((await row(capped.leadId)).due_at).not.toBeNull(); // a lead reply queues
    await makeDue(capped.leadId);
    const r = await run(capped.ws);
    expect(r.outcomes).toEqual([{ leadId: capped.leadId, result: "paused_cap" }]);
    expect(r.model.calls).toEqual([]);
    expect((await api.call(owner, capped.ws, "GET", `/leads/${capped.leadId}/summary`)).body.ai.status).toBe("paused_cap");

    const off = await scenario({ mode: "off" });
    await event(off.leadId, "Meeting scheduled", "meeting");
    await makeDue(off.leadId);
    expect((await run(off.ws)).outcomes).toEqual([{ leadId: off.leadId, result: "off" }]);
  });

  it("Refresh: owner or admin only, once per 5 minutes, skips the 10-minute gap; a non-member gets 403", async () => {
    const { ws, leadId } = await scenario();
    expect((await api.call(outsider, ws, "GET", `/leads/${leadId}/summary`)).status).toBe(403);
    expect((await api.call(outsider, ws, "POST", `/leads/${leadId}/summary/refresh`)).status).toBe(403);
    expect((await api.call(otherRep, ws, "GET", `/leads/${leadId}/summary`)).body.canRefresh).toBe(false);
    expect((await api.call(otherRep, ws, "POST", `/leads/${leadId}/summary/refresh`)).status).toBe(403);
    expect((await api.call(owner, ws, "POST", `/leads/${leadId}/summary/refresh`)).status).toBe(202);
    expect((await api.call(owner, ws, "POST", `/leads/${leadId}/summary/refresh`)).status).toBe(429);
    await pool.query(`update public.lead_summaries set generated_at = now() where lead_id = $1`, [leadId]);
    expect((await run(ws)).outcomes).toEqual([{ leadId, result: "generated" }]);
  });

  it("the prompt never carries reply text (only the timeline title)", async () => {
    const { ws, leadId } = await scenario();
    // A matched reply: the summary reads only the timeline title, never body_* (CLAUDE.md).
    await pool.query(
      `insert into public.whatsapp_inbound_events (message_id, sender_jid, message_type, received_at, match_count, disposition, workspace_id, lead_id, reply_label)
       values ($1, '919700000000@s.whatsapp.net', 'conversation', now(), 1, 'matched', $2, $3, 'question')`,
      [`sum1-${randomUUID()}`, ws, leadId],
    );
    await event(leadId, "WhatsApp reply received - automation stopped", "whatsapp");
    await makeDue(leadId);
    const { model } = await run(ws);
    const prompt = JSON.stringify(model.calls[0]!.input.messages);
    expect(prompt).toContain("whatsapp: WhatsApp reply received - automation stopped");
    expect(prompt).not.toMatch(/body_ciphertext|conversation/);
  });
});
