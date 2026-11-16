/**
 * LL-2 rule 2 (worker, every tick): the "due" bell for open tasks and the admins' escalation of overdue tasks and
 * of website first calls. Every SQL query of the feature lives here (INT-1 verifies them); the rules are pure in
 * domain/reminders.ts. Once-only by markers: tasks.due_notified_at (due bell) and tasks.escalated_at (escalation;
 * reply tasks keep their own 2-working-hour escalation in workReminders.service.ts and never come here).
 * Only tasks due at or after agent_settings.task_reminders_since (migration 059: no flood on release); only for
 * active / long-term-nurture leads (never DNC / terminal / merged); only open tasks.
 */
import { withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { REPLY_TASK_TITLES } from "../agent/replyClassification.js";
import { batchBells } from "../domain/nextAction.js";
import { dueBellAt, dueBellTitle, escalationBellTitle, taskEscalation, type TaskEscalation } from "../domain/reminders.js";
import { fairPickSql } from "./fairPick.js";
import { notifyUsers } from "./nextAction.service.js";

/** P7: at most this many tasks per step per tick, round-robin across workspaces (fairPickSql). */
const TICK_LIMIT = 200;

/** Task + lead + who is responsible (rule 1: the task's owner if an active member, else the active admins). */
const TASK_COLUMNS = `t.id, t.workspace_id, t.lead_id, t.owner_id, t.title, t.due_at,
       coalesce(o.full_name, t.owner_name) as owner_name,
       coalesce(o.is_active, false) and exists (select 1 from public.workspace_members wm where wm.workspace_id = t.workspace_id and wm.user_id = t.owner_id) as owner_ok,
       nullif(trim(concat_ws(' ', l.first_name, l.last_name)), '') as lead_name,
       array(select m.user_id from public.workspace_members m join public.profiles p on p.id = m.user_id and p.is_active
              where m.workspace_id = t.workspace_id and m.role = 'admin') as admin_ids`;

const TASK_JOINS = `from public.tasks t
  join public.leads l on l.id = t.lead_id and l.workspace_id = t.workspace_id
   and l.lifecycle_state in ('active', 'long_term_nurture') and l.merged_into_lead_id is null
  left join public.profiles o on o.id = t.owner_id`;

const GUARDED_FROM = `public.tasks x join public.agent_settings s on s.workspace_id = x.workspace_id and x.due_at >= s.task_reminders_since`;

/**
 * Due bell candidates: due within the next day (a date-only task due 23:59 rings at the day's opening; the exact
 * time is decided by dueBellAt). $1 now, $2 workspace ids (null = all), $3 tick limit.
 */
export const DUE_CANDIDATES_SQL = `select ${TASK_COLUMNS} ${TASK_JOINS}
 where t.id in (${fairPickSql({
   from: GUARDED_FROM,
   where: `x.status = 'open' and x.due_notified_at is null and x.due_at <= $1::timestamptz + interval '1 day'
     and ($2::uuid[] is null or x.workspace_id = any($2::uuid[]))`,
   order: "x.due_at",
   limit: "$3",
 })})
 order by t.due_at`;

/**
 * Escalation candidates: open, overdue, not escalated, not a reply task (they have their own). The working-time
 * thresholds are decided by taskEscalation. $1 now, $2 workspace ids, $3 reply task titles, $4 tick limit.
 * shortcut: oldest due first — a newer first call (1 h threshold) can wait behind 200 older tasks not yet
 * 9.5 h overdue; split the query per kind if that is ever seen.
 */
export const ESCALATION_CANDIDATES_SQL = `select ${TASK_COLUMNS} ${TASK_JOINS}
 where t.id in (${fairPickSql({
   from: GUARDED_FROM,
   where: `x.status = 'open' and x.escalated_at is null and x.due_at < $1::timestamptz
     and not (x.origin = 'agent' and x.title = any($3::text[]))
     and ($2::uuid[] is null or x.workspace_id = any($2::uuid[]))`,
   order: "x.due_at",
   limit: "$4",
 })})
 order by t.due_at`;

/** The claims (the marker is the once-only guard; a task closed meanwhile is skipped). $1 ids, $2 now. */
export const CLAIM_DUE_SQL = `update public.tasks set due_notified_at = $2 where id = any($1::uuid[]) and due_notified_at is null and status = 'open' returning id`;
export const CLAIM_ESCALATION_SQL = `update public.tasks set escalated_at = $2 where id = any($1::uuid[]) and escalated_at is null and status = 'open' returning id`;

export interface TaskReminderRow {
  id: string;
  workspace_id: string;
  lead_id: string;
  owner_id: string | null;
  title: string;
  due_at: Date;
  owner_name: string | null;
  owner_ok: boolean;
  lead_name: string | null;
  admin_ids: string[] | null;
}

const responsibleOf = (r: TaskReminderRow) => (r.owner_ok && r.owner_id ? [r.owner_id] : [...new Set(r.admin_ids ?? [])]);

export interface TaskReminderResult {
  due: string[];
  escalated: { taskId: string; kind: TaskEscalation }[];
}

/** One tick inside one transaction (`db`): due bells (batched per person) then escalations (admins, emailed). */
export async function taskRemindersTick(db: Queryable, opts: { now?: Date; workspaceIds?: string[] } = {}): Promise<TaskReminderResult> {
  const now = opts.now ?? new Date();
  const ws = opts.workspaceIds ?? null;

  // Due bells.
  const dueRows = (await db.query<TaskReminderRow>(DUE_CANDIDATES_SQL, [now, ws, TICK_LIMIT])).rows.filter(
    (r) => dueBellAt(r.due_at).getTime() <= now.getTime(),
  );
  const claimedDue = new Set(
    dueRows.length ? (await db.query<{ id: string }>(CLAIM_DUE_SQL, [dueRows.map((r) => r.id), now])).rows.map((r) => r.id) : [],
  );
  const due = dueRows.filter((r) => claimedDue.has(r.id));
  const items = due.map((r) => ({ workspaceId: r.workspace_id, notify: responsibleOf(r), row: r }));
  for (const bell of batchBells(items)) {
    const mine = items.filter((i) => i.workspaceId === bell.workspaceId && i.notify.includes(bell.recipientId));
    const one = mine.length === 1 ? mine[0]!.row : null;
    await notifyUsers(db, bell.workspaceId, [bell.recipientId], one?.lead_id ?? null, {
      title: dueBellTitle(bell.count, one ? { title: one.title, leadName: one.lead_name ?? "a contact" } : undefined),
      detail: one ? null : mine.map((i) => `${i.row.title} — ${i.row.lead_name ?? "a contact"}`).join("\n").slice(0, 1000),
      kind: "info",
      href: one ? `/contacts/${one.lead_id}` : "/tasks?status=open",
    });
  }

  // Escalations: one bell per task to the workspace's active admins, also by email (rule 3).
  const escRows = (await db.query<TaskReminderRow>(ESCALATION_CANDIDATES_SQL, [now, ws, REPLY_TASK_TITLES, TICK_LIMIT])).rows
    .map((r) => ({ r, kind: taskEscalation({ title: r.title, dueAt: r.due_at, replyTask: false }, now) }))
    .filter((e): e is { r: TaskReminderRow; kind: TaskEscalation } => e.kind !== null);
  const claimedEsc = new Set(
    escRows.length ? (await db.query<{ id: string }>(CLAIM_ESCALATION_SQL, [escRows.map((e) => e.r.id), now])).rows.map((r) => r.id) : [],
  );
  const escalated: TaskReminderResult["escalated"] = [];
  for (const { r, kind } of escRows) {
    if (!claimedEsc.has(r.id)) continue;
    await notifyUsers(db, r.workspace_id, r.admin_ids ?? [], r.lead_id, {
      title: escalationBellTitle(kind, { title: r.title, leadName: r.lead_name ?? "a contact", ownerName: r.owner_id ? r.owner_name : null }),
      detail: kind === "first_call" ? "The first call is still open 1 working hour after it was due." : "This task is still open 1 working day after it was due.",
      kind: "warning",
      email: true,
    });
    escalated.push({ taskId: r.id, kind });
  }
  return { due: due.map((r) => r.id), escalated };
}

/** Worker step: one short transaction per tick. */
export function runTaskReminders(opts: { now?: Date; workspaceIds?: string[] } = {}): Promise<TaskReminderResult> {
  return withTransaction((db) => taskRemindersTick(db, opts));
}
