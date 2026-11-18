/**
 * UX-3: POST /tasks/:id/reopen (Undo for Complete): owner or admin, audited on the timeline, only a completed task,
 * and the LL-2 due bell / escalation are never sent again for a reopened task. Nothing is sent. Skipped unless
 * TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const HOUR = 3_600_000;

describeIfDb("UX-3 reopen task (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let owner: Actor;
  let otherRep: Actor;
  let admin: Actor;
  let ws: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "ux3-reopen");
    owner = await api.newUser("salesperson", { name: "UX3 Owner" });
    otherRep = await api.newUser("salesperson", { name: "UX3 Other" });
    admin = await api.newUser("admin", { name: "UX3 Admin" });
    ws = await createTestWorkspace(pool, "ux3-reopen");
    await pool.query(`update public.agent_settings set task_reminders_since = '2026-01-01' where workspace_id = $1`, [ws]);
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  async function task(over: { dueAt?: Date; status?: "open" | "completed" | "cancelled" } = {}) {
    const lead = await pool.query<{ id: string }>(
      `insert into public.leads (workspace_id, first_name, last_name, company, source, email, owner_id)
       values ($1, 'Asha', 'Rao', 'Acme', 'referral', $2, $3) returning id`,
      [ws, `ux3-${randomUUID()}@example.com`, owner.id],
    );
    const status = over.status ?? "completed";
    const row = await pool.query<{ id: string }>(
      `insert into public.tasks (workspace_id, lead_id, owner_id, task_type, title, due_at, origin, status, completed_at, cancelled_at)
       values ($1, $2, $3, 'follow_up', 'Send the deck', $4, 'manual', ($5::text)::public.task_status,
               case when $5::text = 'completed' then now() end, case when $5::text = 'cancelled' then now() end) returning id`,
      [ws, lead.rows[0]!.id, owner.id, over.dueAt ?? new Date(Date.now() + HOUR), status],
    );
    return { id: row.rows[0]!.id, leadId: lead.rows[0]!.id };
  }
  const reopen = (as: Actor, id: string) => api.call(as, ws, "POST", `/tasks/${id}/reopen`);
  const row = async (id: string) =>
    (await pool.query(`select status, completed_at, due_notified_at, escalated_at from public.tasks where id = $1`, [id])).rows[0];

  it("the owner reopens a completed task; it is audited and idempotent", async () => {
    const t = await task();
    const res = await reopen(owner, t.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: t.id, status: "open" });
    expect(await row(t.id)).toMatchObject({ status: "open", completed_at: null });
    const events = await pool.query(`select title, detail, actor_name from public.timeline_events where lead_id = $1 and title = 'Task Reopened'`, [t.leadId]);
    expect(events.rows).toEqual([{ title: "Task Reopened", detail: "Send the deck", actor_name: "UX3 Owner" }]);
    // Open already: unchanged, no second event.
    expect((await reopen(owner, t.id)).status).toBe(200);
    expect((await pool.query(`select 1 from public.timeline_events where lead_id = $1 and title = 'Task Reopened'`, [t.leadId])).rowCount).toBe(1);
  });

  it("another salesperson gets 403; an admin may reopen; a cancelled task is 409; an unknown task 404", async () => {
    const t = await task();
    expect((await reopen(otherRep, t.id)).status).toBe(403);
    expect((await row(t.id)).status).toBe("completed");
    expect((await reopen(admin, t.id)).status).toBe(200);
    const cancelled = await task({ status: "cancelled" });
    const res = await reopen(owner, cancelled.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Only a completed task/);
    expect((await reopen(owner, randomUUID())).status).toBe(404);
  });

  it("LL-2: a reopened task's due bell and escalation are not sent again", async () => {
    const { runTaskReminders } = await import("../../src/services/taskReminders.service.js");
    // Overdue by 2 days: the tick sends the due bell and the admins' escalation once.
    const t = await task({ status: "open", dueAt: new Date(Date.now() - 48 * HOUR) });
    await runTaskReminders({ workspaceIds: [ws], now: new Date() });
    const sent = await row(t.id);
    expect(sent.due_notified_at).not.toBeNull();
    expect(sent.escalated_at).not.toBeNull();
    // Due bells are batched per person and name no task: count every bell in the workspace.
    const bells = async () => (await pool.query(`select count(*)::int as n from public.notifications where workspace_id = $1`, [ws])).rows[0].n;
    const before = await bells();
    expect(before).toBeGreaterThan(0);

    expect((await api.call(owner, ws, "POST", `/tasks/${t.id}/complete`)).status).toBe(200);
    expect((await reopen(owner, t.id)).status).toBe(200);
    await runTaskReminders({ workspaceIds: [ws], now: new Date() });
    expect(await row(t.id)).toMatchObject({ status: "open", due_notified_at: sent.due_notified_at, escalated_at: sent.escalated_at });
    expect(await bells()).toBe(before);
  });
});
