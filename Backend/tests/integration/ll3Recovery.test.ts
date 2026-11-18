/**
 * LL-3 rules 6–8: Lost recovery (once, reset, cancelled on reopen, DNC / both opted out skipped, AI not restarted),
 * the required discard reason, workflows in long-term nurture. Nothing is sent and nothing calls OpenAI.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const DAY = 86_400_000;

describeIfDb("LL-3 recovery, discard, workflows (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let rep: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "ll3-recovery");
    rep = await api.newUser("salesperson", { name: "Ravi Kumar" });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  async function lead(ws: string, agentStatus = "none") {
    return (
      await pool.query<{ id: string }>(
        `insert into public.leads (workspace_id, first_name, last_name, company, source, email, owner_id, agent_status)
         values ($1, 'Asha', 'Rao', 'Acme', 'referral', $2, $3, $4) returning id`,
        [ws, `ll3r-${randomUUID()}@example.com`, rep.id, agentStatus],
      )
    ).rows[0]!.id;
  }
  const leadRow = async (id: string) =>
    (await pool.query(`select lifecycle_state, recover_at, recovered_at, agent_status, discard_reason, loss_project_date from public.leads where id = $1`, [id])).rows[0];
  const openTasks = async (id: string) => (await pool.query(`select title, task_type, marker, owner_id from public.tasks where lead_id = $1 and status = 'open'`, [id])).rows;
  const lose = (ws: string, id: string, body: Record<string, unknown>) => api.call(rep, ws, "POST", `/leads/${id}/lost`, body);
  const recover = async (ws: string) => (await import("../../src/services/leadRecovery.service.js")).runLostRecovery({ workspaceIds: [ws] });

  it("Lost → recover date by reason; on the date: long-term nurture + 'Re-engage' task + urgent bell, once; AI not restarted", async () => {
    const ws = await createTestWorkspace(pool, "ll3-recovery");
    const id = await lead(ws, "active");
    const res = await lose(ws, id, { lossReason: "price_budget", notes: "Too costly" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.recoverAt).toBeTruthy();
    const lost = await leadRow(id);
    expect(lost.agent_status).toBe("stopped");
    expect(lost.recover_at.getTime()).toBeGreaterThan(Date.now() + 28 * DAY);
    expect(await recover(ws)).toEqual([]);

    await pool.query(`update public.leads set recover_at = now() - interval '1 minute' where id = $1`, [id]);
    expect(await recover(ws)).toEqual([{ leadId: id, outcome: "recovered" }]);
    const back = await leadRow(id);
    expect(back).toMatchObject({ lifecycle_state: "long_term_nurture", agent_status: "stopped" });
    expect(back.recovered_at).not.toBeNull();
    const tasks = await openTasks(id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ task_type: "re_engage", marker: "lost_recovery", owner_id: rep.id });
    expect(tasks[0].title).toMatch(/^Re-engage: Asha Rao — lost \d{4}-\d{2}-\d{2}: Budget$/);
    const bells = (await pool.query(`select recipient_id, email_status from public.notifications where lead_id = $1 and title like 'Re-engage:%'`, [id])).rows;
    expect(bells).toEqual([{ recipient_id: rep.id, email_status: "pending" }]);
    // Once per loss.
    await pool.query(`update public.leads set recover_at = now() - interval '1 minute' where id = $1`, [id]);
    expect(await recover(ws)).toEqual([]);
  });

  it("reopening cancels the recovery; a new loss resets it; postponed = the project date", async () => {
    const ws = await createTestWorkspace(pool, "ll3-recovery");
    const id = await lead(ws);
    await lose(ws, id, { lossReason: "no_response" });
    expect((await api.call(rep, ws, "POST", `/leads/${id}/reactivate`, {})).status).toBe(200);
    expect((await leadRow(id)).recover_at).toBeNull();
    expect((await lose(ws, id, { lossReason: "project_postponed" })).status).toBe(400);
    const res = await lose(ws, id, { lossReason: "project_postponed", projectDate: "2027-05-03" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await leadRow(id);
    expect(row.recover_at).toEqual(new Date("2027-05-03T09:30:00+05:30"));
    expect(row.recovered_at).toBeNull();
  });

  it("never recovers a lead with a DNC channel or opted out on both WhatsApp and email", async () => {
    const ws = await createTestWorkspace(pool, "ll3-recovery");
    const dnc = await lead(ws);
    const both = await lead(ws);
    const one = await lead(ws);
    for (const id of [dnc, both, one]) await lose(ws, id, { lossReason: "other" });
    await pool.query(`insert into public.lead_contact_channels (lead_id, channel, status, reason, updated_by_name) values ($1, 'phone', 'do_not_contact', 'test', 'Test')`, [dnc]);
    for (const [channel, status] of [["whatsapp", "opted_out"], ["email", "unsubscribed"]]) {
      await pool.query(`insert into public.lead_contact_channels (lead_id, channel, status, reason, updated_by_name) values ($1, $2, $3, 'test', 'Test')`, [both, channel, status]);
    }
    await pool.query(`insert into public.lead_contact_channels (lead_id, channel, status, reason, updated_by_name) values ($1, 'whatsapp', 'opted_out', 'test', 'Test')`, [one]);
    await pool.query(`update public.leads set recover_at = now() - interval '1 minute' where id = any($1::uuid[])`, [[dnc, both, one]]);
    const done = await recover(ws);
    expect(Object.fromEntries(done.map((d) => [d.leadId, d.outcome]))).toEqual({ [dnc]: "skipped", [both]: "skipped", [one]: "recovered" });
    expect(await openTasks(dnc)).toEqual([]);
    expect((await leadRow(both)).lifecycle_state).toBe("lost");
  });

  it("discard needs a reason ('other' needs the text); the reason is stored; discarded leads never recover", async () => {
    const ws = await createTestWorkspace(pool, "ll3-recovery");
    const id = await lead(ws);
    expect((await api.call(rep, ws, "POST", `/leads/${id}/discard`, {})).status).toBe(400);
    expect((await api.call(rep, ws, "POST", `/leads/${id}/discard`, { discardReason: "other" })).status).toBe(400);
    const ok = await api.call(rep, ws, "POST", `/leads/${id}/discard`, { discardReason: "duplicate", reason: "Same as Asha R." });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.discardReason).toBe("duplicate");
    expect(await leadRow(id)).toMatchObject({ lifecycle_state: "discarded", discard_reason: "duplicate", recover_at: null });
  });

  it("workflows run in long-term nurture: an enrollment's step executes (worker path), not skipped", async () => {
    const { createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const { enrollLeadInWorkflow } = await import("../../src/services/runs.service.js");
    const automation = await import("../../src/services/automation.service.js");
    const { withTransaction } = await import("../../src/db.js");
    const ws = await createTestWorkspace(pool, "ll3-recovery");
    const admin = await api.newUser("admin", { name: "LL3R Admin" });
    await api.call(admin, ws, "GET", "/tasks/count");
    const wf = await withTransaction((c) => createWorkflow(c, admin, ws, { name: "Nurture (LL-3)", trigger: "meeting_not_a_fit" }));
    await withTransaction((c) => updateDraftSteps(c, ws, wf.id, 1, [{ order: 0, delayDays: 0, action: "create_call_task", config: "Nurture check-in", enabled: true }]));
    await withTransaction((c) => publishVersion(c, admin, ws, wf.id, 1, "keep_existing"));
    await withTransaction((c) => updateWorkflow(c, ws, wf.id, { status: "active" }));
    const id = await lead(ws);
    expect((await api.call(rep, ws, "POST", `/leads/${id}/long-term-nurture`, {})).status).toBe(200);
    const run = await withTransaction((c) => enrollLeadInWorkflow(c, ws, id, wf.id, "LTN test"));
    expect(run).not.toBeNull();
    const action = (await pool.query<{ id: string }>(`select id from public.scheduled_actions where lead_id = $1 and status = 'pending'`, [id])).rows[0]!;
    await pool.query(`update public.scheduled_actions set status = 'executing', last_attempt_at = now() where id = $1`, [action.id]);
    const ctx = await automation.getActionContext(pool, action.id);
    expect(ctx.eligibility.ok).toBe(true);
    const result = await withTransaction((c) => automation.runInternalAction(c, action.id));
    expect((result as { skipped?: boolean }).skipped ?? false).toBe(false);
    expect((await openTasks(id)).map((t) => t.title)).toContain("Nurture check-in");
  });
});
