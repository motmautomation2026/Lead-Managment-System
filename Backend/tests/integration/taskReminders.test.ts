/**
 * LL-2 rule 2: task "due" bells and the admins' overdue / first-call escalation (worker step task_reminders), plus
 * rule 5 (AI send failure bell → responsible person). WRITTEN IN LL-2, NOT RUN THERE (staging was down): INT-1
 * runs it. Nothing is sent and nothing calls OpenAI. Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { addTestMember, createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const HOUR = 3_600_000;
const ist = (local: string) => new Date(`${local}:00+05:30`);

describeIfDb("LL-2 task reminders + escalation (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let owner: Actor;
  let admin: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "ll2-tasks");
    owner = await api.newUser("salesperson", { name: "LL2 Owner" });
    admin = await api.newUser("admin", { name: "LL2 Admin" });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  async function workspace() {
    const ws = await createTestWorkspace(pool, "ll2-tasks");
    await addTestMember(pool, ws, owner.id, "salesperson");
    await addTestMember(pool, ws, admin.id, "admin");
    // Rollout guard far in the past so the fixed test clock counts.
    await pool.query(`update public.agent_settings set task_reminders_since = '2026-01-01' where workspace_id = $1`, [ws]);
    return ws;
  }

  async function lead(ws: string, over: { ownerId?: string | null; lifecycle?: string } = {}) {
    // Lost / DNC leads are created active and moved afterwards: the lifecycle trigger writes dnc_events for the lead row.
    const lifecycle = over.lifecycle ?? "active";
    const terminal = lifecycle === "lost" || lifecycle === "do_not_contact";
    const id = (
      await pool.query<{ id: string }>(
        `insert into public.leads (workspace_id, first_name, last_name, company, source, email, owner_id, lifecycle_state)
         values ($1, 'Asha', 'Rao', 'Acme', 'referral', $2, $3, $4)
         returning id`,
        [ws, `ll2-${randomUUID()}@example.com`, over.ownerId === undefined ? owner.id : over.ownerId, terminal ? "active" : lifecycle],
      )
    ).rows[0]!.id;
    if (lifecycle === "lost") await pool.query(`update public.leads set lifecycle_state = 'lost', loss_reason = 'no_response' where id = $1`, [id]);
    if (lifecycle === "do_not_contact") await pool.query(`update public.leads set lifecycle_state = 'do_not_contact', dnc_reason = 'test', dnc_at = now() where id = $1`, [id]);
    return id;
  }

  async function task(ws: string, leadId: string, over: { title?: string; dueAt: Date; ownerId?: string | null; origin?: string; status?: string }) {
    return (
      await pool.query<{ id: string }>(
        `insert into public.tasks (workspace_id, lead_id, owner_id, task_type, title, due_at, origin, status, completed_at)
         values ($1, $2, $3, 'call', $4, $5, $6, ($7::text)::public.task_status, case when $7::text = 'completed' then now() end) returning id`,
        [ws, leadId, over.ownerId === undefined ? owner.id : over.ownerId, over.title ?? "Call back", over.dueAt, over.origin ?? "manual", over.status ?? "open"],
      )
    ).rows[0]!.id;
  }

  const tick = async (ws: string, now: Date) => (await import("../../src/services/taskReminders.service.js")).runTaskReminders({ workspaceIds: [ws], now });
  const bells = async (ws: string) =>
    (await pool.query(`select recipient_id, title, email_status from public.notifications where workspace_id = $1 order by created_at, recipient_id`, [ws])).rows;

  it("due bells are batched per person per tick and sent once", async () => {
    const ws = await workspace();
    const due = ist("2026-11-17T15:00");
    await task(ws, await lead(ws), { dueAt: due });
    await task(ws, await lead(ws), { dueAt: due });
    await task(ws, await lead(ws), { dueAt: new Date(due.getTime() + 3 * HOUR) }); // not yet
    const first = await tick(ws, new Date(due.getTime() - 10 * 60_000));
    expect(first.due).toHaveLength(2);
    expect(await bells(ws)).toEqual([{ recipient_id: owner.id, title: "2 tasks due now", email_status: null }]);
    expect((await tick(ws, new Date(due.getTime() - 5 * 60_000))).due).toEqual([]);
  });

  it("completed / cancelled tasks and DNC / lost leads never notify", async () => {
    const ws = await workspace();
    const due = ist("2026-11-17T15:00");
    await task(ws, await lead(ws), { dueAt: due, status: "completed" });
    await task(ws, await lead(ws, { lifecycle: "do_not_contact" }), { dueAt: due });
    const res = await tick(ws, ist("2026-11-18T15:00"));
    expect(res).toEqual({ due: [], escalated: [] });
    expect(await bells(ws)).toEqual([]);
  });

  it("overdue by 1 working day → one admins' bell, emailed, once; reply tasks are not escalated here", async () => {
    const ws = await workspace();
    const leadId = await lead(ws);
    await task(ws, leadId, { dueAt: ist("2026-11-16T10:00") });
    // A real reply-task title (REPLY_TASK_TITLES): those are escalated by their own 2-hour rule, never here.
    await task(ws, leadId, { title: "Wants to talk — respond today", origin: "agent", dueAt: ist("2026-11-16T10:00") });
    const res = await tick(ws, ist("2026-11-17T10:05"));
    expect(res.escalated.map((e) => e.kind)).toEqual(["overdue"]);
    await tick(ws, ist("2026-11-17T12:00"));
    const escalations = (await bells(ws)).filter((b) => b.title.startsWith("Overdue"));
    expect(escalations).toEqual([{ recipient_id: admin.id, title: "Overdue: Call back — LL2 Owner", email_status: "pending" }]);
  });

  it("website first call: due 1 working hour after creation; still open 1 working hour after due → admins", async () => {
    const ws = await workspace();
    const leadId = await lead(ws, { ownerId: null });
    await task(ws, leadId, { title: "First call", ownerId: null, dueAt: ist("2026-11-16T10:30") });
    expect((await tick(ws, ist("2026-11-16T11:29"))).escalated).toEqual([]);
    expect((await tick(ws, ist("2026-11-16T11:30"))).escalated.map((e) => e.kind)).toEqual(["first_call"]);
    expect((await bells(ws)).find((b) => b.title.startsWith("New lead not called yet"))).toEqual({
      recipient_id: admin.id,
      title: "New lead not called yet: Asha Rao — no owner",
      email_status: "pending",
    });
  });

  it("tasks due before task_reminders_since are left alone (no flood on release)", async () => {
    const ws = await workspace();
    await pool.query(`update public.agent_settings set task_reminders_since = '2026-11-17' where workspace_id = $1`, [ws]);
    await task(ws, await lead(ws), { dueAt: ist("2026-11-10T10:00") });
    expect(await tick(ws, ist("2026-11-18T10:00"))).toEqual({ due: [], escalated: [] });
  });

  it("rule 5: an AI send failure on a lead with an inactive owner tells the admins", async () => {
    const ws = await workspace();
    const leadId = await lead(ws);
    await pool.query(`update public.profiles set is_active = false where id = $1`, [owner.id]);
    try {
      const decision = (
        await pool.query<{ id: string }>(
          `insert into public.agent_decisions (workspace_id, lead_id, mode, action, reasoning, message_body, outcome, send_status)
           values ($1, $2, 'live', 'send_whatsapp', 'test', 'Hello', 'draft', 'sending') returning id`,
          [ws, leadId],
        )
      ).rows[0]!.id;
      const { recordAgentSendOutcome } = await import("../../src/services/agentSendState.service.js");
      await recordAgentSendOutcome(pool, decision, { kind: "failed", reason: "Recipient is not on WhatsApp" });
      expect((await bells(ws)).map((b) => b.recipient_id)).toEqual([admin.id]);
    } finally {
      await pool.query(`update public.profiles set is_active = true where id = $1`, [owner.id]);
    }
  });
});
