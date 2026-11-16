import { describe, expect, it } from "vitest";
import type { Queryable } from "../../src/dto.js";
import { REPLY_TASK_TITLES } from "../../src/agent/replyClassification.js";
import {
  CLAIM_DUE_SQL,
  CLAIM_ESCALATION_SQL,
  DUE_CANDIDATES_SQL,
  ESCALATION_CANDIDATES_SQL,
  taskRemindersTick,
  type TaskReminderRow,
} from "../../src/services/taskReminders.service.js";
import { recordAgentSendOutcome } from "../../src/services/agentSendState.service.js";
import { fakeNextActionDb } from "../helpers/fakeNextActionDb.js";

const ist = (local: string) => new Date(`${local}:00+05:30`);

const task = (over: Partial<TaskReminderRow> = {}): TaskReminderRow => ({
  id: "t1",
  workspace_id: "ws-1",
  lead_id: "lead-1",
  owner_id: "owner-1",
  title: "Call back",
  due_at: ist("2026-11-17T15:00"),
  owner_name: "Ravi",
  owner_ok: true,
  lead_name: "Asha Rao",
  admin_ids: ["admin-1", "admin-2"],
  ...over,
});

/** Fake tick db: candidate rows per query, claims answer with the ids not yet claimed (once-only markers). */
function fakeTickDb(due: TaskReminderRow[], esc: TaskReminderRow[] = []) {
  const notified = new Set<string>();
  const escalated = new Set<string>();
  const bells: { recipients: string[]; title: string; leadId: string | null; href: string | null; email: string | null }[] = [];
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql === DUE_CANDIDATES_SQL) return { rows: due.filter((r) => !notified.has(r.id)) };
      if (sql === ESCALATION_CANDIDATES_SQL) return { rows: esc.filter((r) => !escalated.has(r.id)) };
      if (sql === CLAIM_DUE_SQL || sql === CLAIM_ESCALATION_SQL) {
        const set = sql === CLAIM_DUE_SQL ? notified : escalated;
        const ids = (params[0] as string[]).filter((id) => !set.has(id));
        ids.forEach((id) => set.add(id));
        return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
      }
      if (sql.includes("insert into public.notifications")) {
        bells.push({ recipients: params[1] as string[], title: params[2] as string, leadId: params[5] as string | null, href: params[6] as string | null, email: params[7] as string | null });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  } as unknown as Queryable;
  return { db, bells, queries };
}

describe("LL-2 due bells", () => {
  it("batched: one bell per person per tick; unowned / inactive owner → the admins", async () => {
    const f = fakeTickDb([
      task({ id: "t1" }),
      task({ id: "t2", lead_id: "lead-2", lead_name: "Vikram Shah" }),
      task({ id: "t3", lead_id: "lead-3", owner_id: null, owner_ok: false }),
      task({ id: "t4", lead_id: "lead-4", owner_id: "gone", owner_ok: false }),
    ]);
    const res = await taskRemindersTick(f.db, { now: ist("2026-11-17T14:50") });
    expect(res.due).toEqual(["t1", "t2", "t3", "t4"]);
    expect(f.bells).toEqual([
      { recipients: ["owner-1"], title: "2 tasks due now", leadId: null, href: "/tasks?status=open", email: null },
      { recipients: ["admin-1"], title: "2 tasks due now", leadId: null, href: "/tasks?status=open", email: null },
      { recipients: ["admin-2"], title: "2 tasks due now", leadId: null, href: "/tasks?status=open", email: null },
    ]);
  });

  it("a single task names the task and the contact", async () => {
    const f = fakeTickDb([task()]);
    await taskRemindersTick(f.db, { now: ist("2026-11-17T14:45") });
    expect(f.bells).toEqual([{ recipients: ["owner-1"], title: "Due now: Call back — Asha Rao", leadId: "lead-1", href: "/contacts/lead-1", email: null }]);
  });

  it("not before 15 min ahead; a date-only task at the day's opening", async () => {
    const f = fakeTickDb([task(), task({ id: "t2", due_at: ist("2026-11-17T23:59") })]);
    expect((await taskRemindersTick(f.db, { now: ist("2026-11-17T09:00") })).due).toEqual([]);
    expect((await taskRemindersTick(f.db, { now: ist("2026-11-17T09:30") })).due).toEqual(["t2"]);
    expect((await taskRemindersTick(f.db, { now: ist("2026-11-17T14:45") })).due).toEqual(["t1"]);
  });

  it("once only: the second tick finds the marker set", async () => {
    const f = fakeTickDb([task()]);
    await taskRemindersTick(f.db, { now: ist("2026-11-17T15:00") });
    await taskRemindersTick(f.db, { now: ist("2026-11-17T15:01") });
    expect(f.bells).toHaveLength(1);
  });

  it("the SQL: open tasks only, active / nurture leads only (never DNC / terminal / merged), rollout guard, fair pick", () => {
    for (const sql of [DUE_CANDIDATES_SQL, ESCALATION_CANDIDATES_SQL]) {
      expect(sql).toContain("x.status = 'open'");
      expect(sql).toContain("l.lifecycle_state in ('active', 'long_term_nurture') and l.merged_into_lead_id is null");
      expect(sql).toContain("x.due_at >= s.task_reminders_since");
      expect(sql).toContain("row_number() over (partition by x.workspace_id");
    }
    expect(CLAIM_DUE_SQL).toContain("due_notified_at is null and status = 'open'");
    expect(CLAIM_ESCALATION_SQL).toContain("escalated_at is null and status = 'open'");
  });
});

describe("LL-2 escalation", () => {
  it("overdue by 1 working day → one bell per task to the admins, also emailed, once", async () => {
    const f = fakeTickDb([], [task({ due_at: ist("2026-11-16T10:00") })]);
    const early = await taskRemindersTick(f.db, { now: ist("2026-11-17T09:59") });
    expect(early.escalated).toEqual([]);
    const res = await taskRemindersTick(f.db, { now: ist("2026-11-17T10:00") });
    expect(res.escalated).toEqual([{ taskId: "t1", kind: "overdue" }]);
    await taskRemindersTick(f.db, { now: ist("2026-11-17T12:00") });
    expect(f.bells).toEqual([{ recipients: ["admin-1", "admin-2"], title: "Overdue: Call back — Ravi", leadId: "lead-1", href: "/contacts/lead-1", email: "pending" }]);
  });

  it("first call 1 working hour after due → 'New lead not called yet'", async () => {
    const f = fakeTickDb([], [task({ title: "First call", owner_id: null, owner_ok: false, owner_name: null, due_at: ist("2026-11-16T10:30") })]);
    expect((await taskRemindersTick(f.db, { now: ist("2026-11-16T11:29") })).escalated).toEqual([]);
    expect((await taskRemindersTick(f.db, { now: ist("2026-11-16T11:30") })).escalated).toEqual([{ taskId: "t1", kind: "first_call" }]);
    expect(f.bells[0]!.title).toBe("New lead not called yet: Asha Rao — no owner");
  });

  it("reply tasks are never escalated here (their own 2-working-hour escalation)", async () => {
    const f = fakeTickDb([], []);
    await taskRemindersTick(f.db, { now: ist("2026-11-17T10:00") });
    const q = f.queries.find((x) => x.sql === ESCALATION_CANDIDATES_SQL)!;
    expect(q.sql).toContain("not (x.origin = 'agent' and x.title = any($3::text[]))");
    expect(q.params[2]).toEqual(REPLY_TASK_TITLES);
  });

  it("a task closed meanwhile (claim returns nothing) → no bell", async () => {
    const f = fakeTickDb([], [task({ due_at: ist("2026-11-16T10:00") })]);
    const closedDb = {
      query: async (sql: string, params: unknown[]) => (sql === CLAIM_ESCALATION_SQL ? { rows: [], rowCount: 0 } : (f.db.query as (s: string, p: unknown[]) => Promise<unknown>)(sql, params)),
    } as unknown as Queryable;
    expect((await taskRemindersTick(closedDb, { now: ist("2026-11-18T10:00") })).escalated).toEqual([]);
    expect(f.bells).toEqual([]);
  });
});

describe("LL-2 rule 5: 'AI message failed' bell uses the responsible person", () => {
  const decision = { match: "from public.agent_decisions where id = $1 for update", rows: [{ lead_id: "lead-1", workspace_id: "ws-1", action: "send_whatsapp", message_subject: null, send_status: "sending" }] };
  const name = { match: "concat_ws(' ', first_name", rows: [{ name: "Asha Rao" }] };

  it("active member owner → the owner", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1", extra: [decision, name] });
    await recordAgentSendOutcome(f.db, "d1", { kind: "failed", reason: "Recipient is not on WhatsApp" });
    expect(f.bells).toMatchObject([{ recipients: ["owner-1"], title: "AI message to Asha Rao failed" }]);
  });

  it("inactive / missing owner → the workspace's active admins", async () => {
    for (const state of [{ ownerId: "owner-1", ownerActive: false }, { ownerId: null }]) {
      const f = fakeNextActionDb({ ...state, adminIds: ["a1", "a2"], extra: [decision, name] });
      await recordAgentSendOutcome(f.db, "d1", { kind: "failed", reason: "x" });
      expect(f.bells).toMatchObject([{ recipients: ["a1", "a2"] }]);
    }
  });
});
