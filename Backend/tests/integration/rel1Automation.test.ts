/**
 * REL-1: old leads (created before the workspace's go-live cutoff) get no automatic tasks, bells or messages; an admin
 * or the owner switches automation on / off (one contact or a filtered list); a manual AI / workflow enrolment switches
 * it on; switching on never replays the past. Nothing is sent and nothing calls OpenAI. Skipped unless
 * TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const DAY = 86_400_000;

describeIfDb("REL-1 automation cutoff + opt-in (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let admin: Actor;
  let rep: Actor;
  let other: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "rel1");
    admin = await api.newUser("admin", { name: "REL1 Admin" });
    rep = await api.newUser("salesperson", { name: "REL1 Rep" });
    other = await api.newUser("salesperson", { name: "REL1 Other" });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

  /** Reminders / sweep look back far enough that only the REL-1 guard decides. */
  async function workspace() {
    const ws = await createTestWorkspace(pool, "rel1");
    await pool.query(
      `update public.agent_settings set task_reminders_since = '2026-01-01', reminders_since = '2026-01-01', next_action_sweep_since = '2026-01-01' where workspace_id = $1`,
      [ws],
    );
    return ws;
  }

  const randomPhone = () => `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  /** `old` = created a week before the workspace's cutoff. */
  async function lead(ws: string, opts: { old: boolean; ownerId?: string; agentStatus?: string }) {
    const phone = randomPhone();
    return (
      await pool.query<{ id: string }>(
        `insert into public.leads (workspace_id, first_name, last_name, company, source, email, phone, phone_e164, owner_id, agent_status, created_at, last_activity_at)
         values ($1, 'Asha', 'Rao', 'Acme', 'referral', $2, $3, $3, $4, $5, case when $6 then now() - interval '7 days' else now() end, now())
         returning id`,
        [ws, `rel1-${randomUUID()}@example.com`, phone, opts.ownerId ?? rep.id, opts.agentStatus ?? "none", opts.old],
      )
    ).rows[0]!.id;
  }
  const task = (ws: string, leadId: string, origin: "manual" | "agent", dueAt: Date, title = "Follow up") =>
    pool.query(`insert into public.tasks (workspace_id, lead_id, owner_id, task_type, title, due_at, origin) values ($1, $2, $3, 'follow_up', $4, $5, $6)`, [
      ws,
      leadId,
      rep.id,
      title,
      dueAt,
      origin,
    ]);
  const openTitles = async (leadId: string) =>
    (await pool.query<{ title: string }>(`select title from public.tasks where lead_id = $1 and status = 'open' order by created_at`, [leadId])).rows.map((r) => r.title);
  const sweep = async (ws: string) => (await import("../../src/services/nextAction.service.js")).runNextActionSweep({ workspaceIds: [ws] });
  const reminders = async (ws: string, now = new Date()) => (await import("../../src/services/taskReminders.service.js")).runTaskReminders({ workspaceIds: [ws], now });
  const switchOne = (actor: Actor, ws: string, id: string, enabled: boolean) => api.call(actor, ws, "POST", "/contacts/automation", { enabled, ids: [id] });

  it("an old lead gets no sweep task, no automatic-task bell and no escalation; a new lead does; a rep's own task still rings", async () => {
    const ws = await workspace();
    const oldLead = await lead(ws, { old: true });
    const newLead = await lead(ws, { old: false });
    expect((await sweep(ws)).map((c) => c.leadId)).toEqual([newLead]);
    expect(await openTitles(oldLead)).toEqual([]);

    const now = new Date();
    const overdue = new Date(now.getTime() - 4 * DAY);
    await task(ws, oldLead, "agent", overdue, "Old automatic task");
    await task(ws, newLead, "agent", overdue, "New automatic task");
    const manualOld = await lead(ws, { old: true });
    await task(ws, manualOld, "manual", new Date(now.getTime() - 60_000), "Rep's own task");
    const result = await reminders(ws, now);
    const titles = async (ids: string[]) => (await pool.query<{ title: string }>(`select title from public.tasks where id = any($1::uuid[])`, [ids])).rows.map((r) => r.title);
    const dueTitles = await titles(result.due);
    expect(dueTitles).toContain("New automatic task");
    expect(dueTitles).toContain("Rep's own task");
    expect(dueTitles).not.toContain("Old automatic task");
    expect(await titles(result.escalated.map((e) => e.taskId))).toEqual(["New automatic task"]);
  });

  it("No answer on an old lead: no ladder task and no 'We tried calling'; on a new lead both", async () => {
    const ws = await workspace();
    const oldLead = await lead(ws, { old: true });
    const newLead = await lead(ws, { old: false });
    for (const id of [oldLead, newLead]) {
      expect((await api.call(rep, ws, "POST", `/leads/${id}/calls`, { connected: false, notConnectedReason: "no_answer" })).status).toBe(201);
    }
    expect(await openTitles(oldLead)).toEqual([]);
    expect(await openTitles(newLead)).toEqual(["Call attempt 2"]);
    const tried = async (id: string) => (await pool.query(`select 1 from public.tried_calling_messages where lead_id = $1`, [id])).rowCount;
    expect(await tried(oldLead)).toBe(0);
    expect(await tried(newLead)).toBe(1);
  });

  it("switching on (owner): timeline row, contact shows who/when, the next sweep gives ONE next-step task, an older overdue task is not escalated", async () => {
    const ws = await workspace();
    const id = await lead(ws, { old: true });
    await task(ws, id, "agent", new Date(Date.now() - 4 * DAY), "Overdue before opt-in");
    await pool.query(`update public.tasks set status = 'completed', completed_at = now() where lead_id = $1`, [id]);

    expect((await switchOne(other, ws, id, true)).status).toBe(403);
    const on = await switchOne(rep, ws, id, true);
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ changed: 1, unchanged: 0 });
    expect((await switchOne(rep, ws, id, true)).body).toEqual({ changed: 0, unchanged: 1 });
    const contact = await api.call(rep, ws, "GET", `/contacts/${id}`);
    expect(contact.body.automation).toMatchObject({ automated: true, enabled: true, setByName: "REL1 Rep" });
    const timeline = await pool.query(`select title, actor_name from public.timeline_events where lead_id = $1 and title like 'Automation switched%'`, [id]);
    expect(timeline.rows).toEqual([{ title: "Automation switched on", actor_name: "REL1 Rep" }]);

    expect((await sweep(ws)).map((c) => c.leadId)).toEqual([id]);
    expect(await sweep(ws)).toEqual([]);
    expect(await openTitles(id)).toEqual(["Decide the next step"]);

    // A task that was already overdue before the switch is never escalated (no back-dated reminders).
    await task(ws, id, "agent", new Date(Date.now() - 4 * DAY), "Back-dated");
    const result = await reminders(ws);
    expect(result.escalated).toEqual([]);
  });

  it("switching off pauses the lead's workflow runs and stops the sweep; switching on again leaves them paused", async () => {
    const ws = await workspace();
    const id = await lead(ws, { old: false });
    const { createTemplate, createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const template = await tx((c) => createTemplate(c, admin, ws, { name: `REL1 ${randomUUID()}`, channel: "whatsapp", body: "Hi" }));
    const wf = await tx((c) => createWorkflow(c, admin, ws, { name: `REL1 ${randomUUID()}`, trigger: "lead_created" }));
    await tx((c) => updateDraftSteps(c, ws, wf.id, 1, [{ order: 0, delayDays: 1, action: "send_whatsapp", templateId: template.id, enabled: true }]));
    await tx((c) => publishVersion(c, admin, ws, wf.id, 1, "keep_existing"));
    await tx((c) => updateWorkflow(c, ws, wf.id, { status: "active" }));
    const { autoEnroll } = await import("../../src/services/runs.service.js");
    const runs = await tx((c) => autoEnroll(c, ws, id, "lead_created", "REL1"));
    expect(runs).toHaveLength(1);
    // An old lead is never auto-enrolled.
    const oldLead = await lead(ws, { old: true });
    expect(await tx((c) => autoEnroll(c, ws, oldLead, "lead_created", "REL1"))).toEqual([]);

    expect((await switchOne(admin, ws, id, false)).body).toEqual({ changed: 1, unchanged: 0 });
    const run = async () => (await pool.query(`select r.status, a.status as step from public.workflow_runs r join public.scheduled_actions a on a.workflow_run_id = r.id where r.lead_id = $1`, [id])).rows;
    expect(await run()).toEqual([{ status: "paused", step: "paused" }]);
    expect(await sweep(ws)).toEqual([]);
    await switchOne(admin, ws, id, true);
    expect(await run()).toEqual([{ status: "paused", step: "paused" }]);
  });

  it("a manual workflow / AI enrolment of an old lead switches automation on", async () => {
    const ws = await workspace();
    await pool.query(`update public.agent_settings set mode = 'shadow' where workspace_id = $1`, [ws]);
    const forAi = await lead(ws, { old: true });
    const enrolled = await api.call(admin, ws, "POST", "/agent/leads/enroll", { leadIds: [forAi] });
    expect(enrolled.body.data).toEqual([{ leadId: forAi, result: "enrolled" }]);
    const state = async (id: string) => (await pool.query(`select automation_enabled, automation_set_by from public.leads where id = $1`, [id])).rows[0];
    expect(await state(forAi)).toEqual({ automation_enabled: true, automation_set_by: admin.id });

    const { createTemplate, createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const template = await tx((c) => createTemplate(c, admin, ws, { name: `REL1 ${randomUUID()}`, channel: "whatsapp", body: "Hi" }));
    const wf = await tx((c) => createWorkflow(c, admin, ws, { name: `REL1 ${randomUUID()}`, trigger: "manual_enrollment" }));
    await tx((c) => updateDraftSteps(c, ws, wf.id, 1, [{ order: 0, delayDays: 1, action: "send_whatsapp", templateId: template.id, enabled: true }]));
    await tx((c) => publishVersion(c, admin, ws, wf.id, 1, "keep_existing"));
    await tx((c) => updateWorkflow(c, ws, wf.id, { status: "active" }));
    const forWf = await lead(ws, { old: true });
    expect((await api.call(rep, ws, "POST", "/runs", { leadId: forWf, workflowId: wf.id })).status).toBe(201);
    expect(await state(forWf)).toEqual({ automation_enabled: true, automation_set_by: rep.id });
  });

  it("an old lead's pending AI wake-up is not claimed", async () => {
    const ws = await workspace();
    await pool.query(`update public.agent_settings set mode = 'shadow' where workspace_id = $1`, [ws]);
    const id = await lead(ws, { old: true, agentStatus: "active" });
    await pool.query(`insert into public.agent_wakeups (workspace_id, lead_id, reason, due_at) values ($1, $2, 'enrolled', now() - interval '1 minute')`, [ws, id]);
    const { runAgentTick } = await import("../../src/services/agentRunner.service.js");
    const outcomes = await runAgentTick(true, { model: {} as never, workspaceIds: [ws] } as never);
    expect(outcomes).toEqual([]);
    expect((await pool.query(`select status from public.agent_wakeups where lead_id = $1`, [id])).rows).toEqual([{ status: "pending" }]);
  });

  it("bulk over the filtered list: count must match what was confirmed; salespeople change only their own contacts; audited", async () => {
    const ws = await workspace();
    const mine = [await lead(ws, { old: true }), await lead(ws, { old: true })];
    const notMine = await lead(ws, { old: true, ownerId: other.id });
    const stale = await api.call(rep, ws, "POST", "/contacts/automation/filtered", { enabled: true, expectedCount: 2 });
    expect(stale.status).toBe(409);
    const done = await api.call(rep, ws, "POST", "/contacts/automation/filtered", { enabled: true, expectedCount: 3 });
    expect(done.body).toEqual({ changed: 2, unchanged: 1 });
    const enabled = (await pool.query<{ id: string }>(`select id from public.leads where workspace_id = $1 and automation_enabled`, [ws])).rows.map((r) => r.id).sort();
    expect(enabled).toEqual([...mine].sort());
    expect(enabled).not.toContain(notMine);
    const audit = await pool.query(`select action, metadata from public.admin_audit_events where actor_id = $1 and action = 'contacts.automation_on' and metadata ->> 'workspaceId' = $2`, [rep.id, ws]);
    expect(audit.rows[0]?.metadata).toMatchObject({ asked: 3, changed: 2 });
    expect((await api.call(admin, ws, "POST", "/contacts/automation/filtered?ownerId=bogus", { enabled: false, expectedCount: 1 })).status).toBe(400);
  });
});
