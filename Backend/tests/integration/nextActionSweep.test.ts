/**
 * LL-1 safety net: the worker's next-action sweep (rules 1–4). WRITTEN IN LL-1, NOT RUN THERE (staging was
 * down): INT-1 runs it. Nothing is sent and nothing calls OpenAI. Skipped unless TEST_DATABASE_URL is set;
 * [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("LL-1 next-action sweep (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let owner: Actor;
  let admin: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "ll1-sweep");
    owner = await api.newUser("salesperson", { name: "LL1 Owner" });
    admin = await api.newUser("admin", { name: "LL1 Admin" });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  async function workspace(opts: { mode?: "off" | "shadow" | "live"; scope?: string } = {}) {
    const ws = await createTestWorkspace(pool, "ll1-sweep");
    await pool.query(`update public.agent_settings set mode = $2, live_scope = $3 where workspace_id = $1`, [ws, opts.mode ?? "off", opts.scope ?? "all"]);
    return ws;
  }

  async function lead(ws: string, over: { ownerId?: string | null; lifecycle?: string; agentStatus?: string; touches?: number; automation?: string; lastActivity?: string } = {}) {
    const row = await pool.query<{ id: string }>(
      `insert into public.leads (workspace_id, first_name, last_name, company, source, email, owner_id, lifecycle_state, agent_status, agent_touch_count, automation_mode, last_activity_at,
                                 loss_reason, dnc_reason, dnc_at)
       values ($1, 'Lena', 'Lost', 'Acme', 'referral', $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()),
               case when $4 = 'lost' then 'no_response' end, case when $4 = 'do_not_contact' then 'test' end, case when $4 = 'do_not_contact' then now() end)
       returning id`,
      [ws, `ll1-${randomUUID()}@example.com`, over.ownerId === undefined ? owner.id : over.ownerId, over.lifecycle ?? "active", over.agentStatus ?? "none", over.touches ?? 0, over.automation ?? "manual", over.lastActivity ?? null],
    );
    return row.rows[0]!.id;
  }

  const sweep = async (ws: string) => (await import("../../src/services/nextAction.service.js")).runNextActionSweep({ workspaceIds: [ws] });
  const openTasks = async (leadId: string) =>
    (await pool.query(`select title, task_type, owner_id from public.tasks where lead_id = $1 and status = 'open' order by created_at`, [leadId])).rows;
  const bells = async (ws: string) =>
    (await pool.query(`select recipient_id, title, href from public.notifications where workspace_id = $1 and title like '%need%next step' order by recipient_id`, [ws])).rows;

  it("a lead whose task was completed → one 'Decide the next step' task + timeline row + ONE batched bell for 2 leads", async () => {
    const ws = await workspace();
    const a = await lead(ws);
    const b = await lead(ws);
    await pool.query(
      `insert into public.tasks (workspace_id, lead_id, owner_id, task_type, title, due_at, status, completed_at) values ($1, $2, $3, 'call', 'First call', now(), 'completed', now())`,
      [ws, a, owner.id],
    );
    const created = await sweep(ws);
    expect(created.map((c) => c.leadId).sort()).toEqual([a, b].sort());
    expect(await openTasks(a)).toEqual([{ title: "Decide the next step", task_type: "follow_up", owner_id: owner.id }]);
    const timeline = await pool.query(`select title from public.timeline_events where lead_id = $1 and title = 'No next action — task created'`, [a]);
    expect(timeline.rowCount).toBe(1);
    expect(await bells(ws)).toEqual([{ recipient_id: owner.id, title: "2 leads need a next step", href: "/tasks?status=open&q=Decide%20the%20next%20step" }]);
  });

  it("second tick → no duplicate task, no new bell", async () => {
    const ws = await workspace();
    const a = await lead(ws);
    await sweep(ws);
    expect(await sweep(ws)).toEqual([]);
    expect(await openTasks(a)).toHaveLength(1);
    expect(await bells(ws)).toHaveLength(1);
  });

  it("AI-active live contact with touches left → nothing; AI stopped or out of touches → task", async () => {
    const ws = await workspace({ mode: "live", scope: "all" });
    const covered = await lead(ws, { agentStatus: "active", touches: 3 });
    const stopped = await lead(ws, { agentStatus: "stopped" });
    const spent = await lead(ws, { agentStatus: "active", touches: 8 });
    const created = (await sweep(ws)).map((c) => c.leadId);
    expect(created).not.toContain(covered);
    expect(created).toEqual(expect.arrayContaining([stopped, spent]));
  });

  it("shadow AI never covers a lead (it sends nothing)", async () => {
    const ws = await workspace({ mode: "shadow" });
    const shadow = await lead(ws, { agentStatus: "active", touches: 1 });
    expect((await sweep(ws)).map((c) => c.leadId)).toEqual([shadow]);
  });

  it("workflow run with a pending step → nothing; completed run → task; pending step on a manual lead → task", async () => {
    const ws = await workspace();
    const workflow = await pool.query<{ id: string }>(`insert into public.workflows (workspace_id, name, trigger, status) values ($1, $2, 'manual_enrollment', 'active') returning id`, [ws, `LL1 ${randomUUID()}`]);
    const version = await pool.query<{ id: string }>(`insert into public.workflow_versions (workflow_id, version_number, status, published_at) values ($1, 1, 'published', now()) returning id`, [workflow.rows[0]!.id]);
    const step = await pool.query<{ id: string }>(`insert into public.workflow_steps (workflow_version_id, step_order, delay_days, action) values ($1, 0, 2, 'send_email') returning id`, [version.rows[0]!.id]);
    const enrol = async (leadId: string, status: string, pending: boolean) => {
      const run = await pool.query<{ id: string }>(`insert into public.workflow_runs (workspace_id, workflow_id, workflow_version_id, lead_id, status) values ($1, $2, $3, $4, $5) returning id`, [
        ws,
        workflow.rows[0]!.id,
        version.rows[0]!.id,
        leadId,
        status,
      ]);
      if (pending) {
        await pool.query(
          `insert into public.scheduled_actions (workspace_id, lead_id, workflow_run_id, workflow_step_id, action_type, scheduled_for, status) values ($1, $2, $3, $4, 'send_email', now() + interval '2 days', 'pending')`,
          [ws, leadId, run.rows[0]!.id, step.rows[0]!.id],
        );
      }
    };
    const running = await lead(ws, { automation: "active" });
    await enrol(running, "waiting", true);
    const done = await lead(ws, { automation: "active" });
    await enrol(done, "completed", false);
    const manual = await lead(ws, { automation: "manual" });
    await enrol(manual, "waiting", true);
    const created = (await sweep(ws)).map((c) => c.leadId);
    expect(created).not.toContain(running);
    expect(created).toEqual(expect.arrayContaining([done, manual]));
  });

  it("future meeting → nothing; a past one → task", async () => {
    const ws = await workspace();
    const future = await lead(ws);
    const past = await lead(ws);
    const meet = (leadId: string, when: string) =>
      pool.query(`insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status) values ($1, $2, $3, 'Intro', now() + $4::interval, 'scheduled')`, [ws, leadId, owner.id, when]);
    await meet(future, "2 days");
    await meet(past, "-2 days");
    const created = (await sweep(ws)).map((c) => c.leadId);
    expect(created).not.toContain(future);
    expect(created).toContain(past);
  });

  it("long-term nurture → 'Plan re-engagement' re_engage +45 d", async () => {
    const ws = await workspace();
    const ltn = await lead(ws, { lifecycle: "long_term_nurture" });
    await sweep(ws);
    expect(await openTasks(ltn)).toEqual([{ title: "Plan re-engagement", task_type: "re_engage", owner_id: owner.id }]);
    const due = (await pool.query(`select due_at > now() + interval '44 days' as later from public.tasks where lead_id = $1`, [ltn])).rows[0];
    expect(due.later).toBe(true);
  });

  it("DNC, lost → nothing; last activity before next_action_sweep_since → nothing", async () => {
    const ws = await workspace();
    await lead(ws, { lifecycle: "do_not_contact" });
    await lead(ws, { lifecycle: "lost" });
    await lead(ws, { lastActivity: new Date(Date.now() - 86_400_000).toISOString() });
    expect(await sweep(ws)).toEqual([]);
  });

  it("unowned lead → unowned task + the admins' bell", async () => {
    const ws = await workspace();
    const unowned = await lead(ws, { ownerId: null });
    await sweep(ws);
    expect(await openTasks(unowned)).toEqual([{ title: "Decide the next step", task_type: "follow_up", owner_id: null }]);
    expect((await bells(ws)).map((b) => b.recipient_id)).toEqual([admin.id]);
  });

  it("dry-run counts match what a sweep would do and write nothing", async () => {
    const ws = await workspace();
    await lead(ws);
    await lead(ws);
    const { countNextActionSweep } = await import("../../src/services/nextAction.service.js");
    expect((await countNextActionSweep(pool, { workspaceIds: [ws] })).map((c) => c.count)).toEqual([2]);
    expect((await pool.query(`select count(*)::int as n from public.tasks where workspace_id = $1`, [ws])).rows[0].n).toBe(0);
  });
});
