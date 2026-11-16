/**
 * LL-1 safety net: no active lead without a next action. Every SQL query of the feature lives here
 * (INT-1 verifies them against staging): who is responsible (rule 1), the sweep's candidates and its
 * per-lead re-check (rules 2–4). The rules themselves are pure: domain/nextAction.ts.
 */
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import type { AutomationMode, LifecycleState, NotificationKind, TaskOrigin, TaskType } from "../domain/enums.js";
import {
  batchBells,
  needsNextAction,
  NO_NEXT_ACTION_TIMELINE_TITLE,
  resolveResponsible,
  sweepBellTitle,
  sweepTask,
  type NextActionFacts,
  type Responsible,
} from "../domain/nextAction.js";
import { WORKSPACE_ADMIN_IDS_SQL } from "./profiles.service.js";
import { createTask, type TaskRow } from "./tasks.service.js";
import { addTimelineEvent, AUTOMATION_ACTOR } from "./timeline.service.js";
import { liveContactSql } from "./agentSendState.service.js";

// --- Rule 1: who is responsible ----------------------------------------------------------------

/** $1 workspace, $2 lead: the owner (active? member?) and the workspace's active admins. */
export const RESPONSIBLE_SQL = `select l.owner_id, o.full_name as owner_name, coalesce(o.is_active, false) as owner_active,
       exists (select 1 from public.workspace_members m where m.workspace_id = $1 and m.user_id = l.owner_id) as owner_member,
       array(${WORKSPACE_ADMIN_IDS_SQL}) as admin_ids
  from public.leads l left join public.profiles o on o.id = l.owner_id
 where l.id = $2 and l.workspace_id = $1`;

export async function loadResponsible(db: Queryable, workspaceId: string, leadId: string): Promise<Responsible> {
  const row = (
    await db.query<{ owner_id: string | null; owner_name: string | null; owner_active: boolean; owner_member: boolean; admin_ids: string[] | null }>(RESPONSIBLE_SQL, [
      workspaceId,
      leadId,
    ])
  ).rows[0];
  return resolveResponsible({
    owner: row?.owner_id ? { id: row.owner_id, name: row.owner_name, active: row.owner_active, member: row.owner_member } : null,
    adminIds: row?.admin_ids ?? [],
  });
}

export interface Bell {
  title: string;
  detail?: string | null;
  kind?: NotificationKind;
  href?: string;
}

/** One bell per recipient (same insert as every other bell). */
export async function notifyUsers(db: Queryable, workspaceId: string, recipients: string[], leadId: string | null, bell: Bell): Promise<void> {
  if (!recipients.length) return;
  await db.query(
    `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, lead_id, href)
     select $1, r, $3, $4, $5, $6, $7 from unnest($2::uuid[]) r`,
    [workspaceId, [...new Set(recipients)], bell.title, bell.detail ?? null, bell.kind ?? "info", leadId, bell.href ?? (leadId ? `/contacts/${leadId}` : null)],
  );
}

/** Rule 1 bell: the lead's owner when responsible, else the workspace's active admins. */
export async function notifyResponsible(db: Queryable, workspaceId: string, leadId: string, bell: Bell): Promise<Responsible> {
  const responsible = await loadResponsible(db, workspaceId, leadId);
  await notifyUsers(db, workspaceId, responsible.notify, leadId, bell);
  return responsible;
}

export interface ResponsibleTaskInput {
  type: TaskType;
  title: string;
  dueAt: Date;
  origin?: TaskOrigin;
}

/**
 * Rule 1 task: owned by the lead's owner when responsible, else unowned (the admins get the bell).
 * `bell` goes to the responsible person(s); without one an unowned task still tells the admins;
 * `false` = the caller sends (batches) the bells itself.
 */
export async function createResponsibleTask(
  db: Queryable,
  workspaceId: string,
  leadId: string,
  task: ResponsibleTaskInput,
  bell?: Bell | false,
): Promise<{ task: TaskRow; responsible: Responsible }> {
  const responsible = await loadResponsible(db, workspaceId, leadId);
  const row = await createTask(db, null, workspaceId, {
    leadId,
    ownerId: responsible.ownerId,
    ownerName: responsible.ownerName,
    type: task.type,
    title: task.title,
    dueAt: task.dueAt.toISOString(),
    origin: task.origin ?? "manual",
  });
  if (bell === false) return { task: row, responsible };
  const toSend = bell ?? (responsible.ownerId ? null : { title: `Unassigned contact needs: ${task.title}`, kind: "warning" as const });
  if (toSend) await notifyUsers(db, workspaceId, responsible.notify, leadId, toSend);
  return { task: row, responsible };
}

// --- Rules 2–4: the sweep -----------------------------------------------------------------------

const PER_WORKSPACE = 200;
/** P7: at most this many leads per tick in all, round-robin across workspaces. */
const TICK_LIMIT = 1000;
const OPEN_MEETING_STATUSES = `('tentative', 'scheduled', 'confirmed', 'rescheduled')`;

/** Columns of NextActionFacts for lead `l` ⋈ agent_settings `s`; `now` is a bind parameter. */
const factsColumns = (now: string) => `l.id, l.workspace_id, l.lifecycle_state, l.automation_mode, l.agent_status, l.agent_touch_count, s.max_touches_total,
       (s.mode = 'live' and ${liveContactSql("s.live_scope", "s.live_since")}) as ai_live,
       (select count(*)::int from public.tasks t where t.lead_id = l.id and t.status = 'open') as open_tasks,
       exists (select 1 from public.meetings m where m.lead_id = l.id and m.scheduled_at > ${now} and m.status::text in ${OPEN_MEETING_STATUSES}) as future_meeting,
       exists (select 1 from public.workflow_runs r join public.scheduled_actions a on a.workflow_run_id = r.id
                where r.lead_id = l.id and r.status in ('running', 'waiting') and a.status in ('pending', 'due', 'executing')) as workflow_step_pending`;

/**
 * SQL mirror of needsNextAction (rule 2) + the rollout guard (rule 4: activity — last_activity_at, an AI
 * status change or a task closed — at or after `since`, default the workspace's next_action_sweep_since).
 * $1 now, $2 workspace ids (null = all), $3 since override (null = the setting).
 */
const CANDIDATE_WHERE = `l.lifecycle_state in ('active', 'long_term_nurture') and l.merged_into_lead_id is null
   and ($2::uuid[] is null or l.workspace_id = any($2::uuid[]))
   and not exists (select 1 from public.tasks t where t.lead_id = l.id and t.status = 'open')
   and not exists (select 1 from public.meetings m where m.lead_id = l.id and m.scheduled_at > $1 and m.status::text in ${OPEN_MEETING_STATUSES})
   and not (l.lifecycle_state = 'active' and l.automation_mode = 'active'
            and exists (select 1 from public.workflow_runs r join public.scheduled_actions a on a.workflow_run_id = r.id
                         where r.lead_id = l.id and r.status in ('running', 'waiting') and a.status in ('pending', 'due', 'executing')))
   and not (l.agent_status = 'active' and l.agent_touch_count < s.max_touches_total and s.mode = 'live' and ${liveContactSql("s.live_scope", "s.live_since")})
   and (l.last_activity_at >= coalesce($3::timestamptz, s.next_action_sweep_since)
        or l.agent_status_changed_at >= coalesce($3::timestamptz, s.next_action_sweep_since)
        or exists (select 1 from public.tasks t where t.lead_id = l.id and t.status <> 'open'
                    and t.updated_at >= coalesce($3::timestamptz, s.next_action_sweep_since)))`;

/** Rule 3: each workspace's oldest-activity leads first, ≤ $4 per workspace, ≤ $5 in all (round-robin). */
export const SWEEP_CANDIDATES_SQL = `select c.id, c.workspace_id from (
    select l.id, l.workspace_id, l.last_activity_at,
           row_number() over (partition by l.workspace_id order by l.last_activity_at, l.id) as rn
      from public.leads l join public.agent_settings s on s.workspace_id = l.workspace_id
     where ${CANDIDATE_WHERE}) c
  where c.rn <= $4
  order by c.rn, c.last_activity_at, c.id
  limit $5`;

/** Rule 4 dry run: how many leads each workspace would get a task for (no limit). */
export const SWEEP_COUNTS_SQL = `select l.workspace_id, w.name as workspace_name, count(*)::int as count
  from public.leads l join public.agent_settings s on s.workspace_id = l.workspace_id
  join public.workspaces w on w.id = l.workspace_id
 where ${CANDIDATE_WHERE}
 group by l.workspace_id, w.name
 order by w.name`;

/** The per-lead re-check inside the write transaction (lead row locked): $1 lead, $2 now. */
export const LEAD_FACTS_SQL = `select ${factsColumns("$2")}
  from public.leads l join public.agent_settings s on s.workspace_id = l.workspace_id
 where l.id = $1 and l.merged_into_lead_id is null
 for update of l`;

interface FactsRow {
  id: string;
  workspace_id: string;
  lifecycle_state: LifecycleState;
  automation_mode: AutomationMode;
  agent_status: NextActionFacts["ai"]["status"];
  agent_touch_count: number;
  max_touches_total: number;
  ai_live: boolean;
  open_tasks: number;
  future_meeting: boolean;
  workflow_step_pending: boolean;
}

export function factsOf(row: FactsRow): NextActionFacts {
  return {
    lifecycle: row.lifecycle_state,
    openTasks: row.open_tasks,
    futureMeeting: row.future_meeting,
    automationMode: row.automation_mode,
    workflowStepPending: row.workflow_step_pending,
    ai: { status: row.agent_status, live: row.ai_live, touches: row.agent_touch_count, maxTouches: row.max_touches_total },
  };
}

export interface SweepOptions {
  now?: Date;
  workspaceIds?: string[];
  /** Overrides each workspace's next_action_sweep_since (CLI --since). */
  since?: Date;
  perWorkspace?: number;
}

/**
 * One lead, in its own transaction: lock, re-check with the domain rule (a task created since the
 * candidate query wins: the open task itself stops repeats), create the task + timeline row.
 * Returns who to tell, or null when nothing was needed.
 */
export async function sweepLead(db: Queryable, leadId: string, now: Date): Promise<{ workspaceId: string; taskId: string; notify: string[]; title: string } | null> {
  const row = (await db.query<FactsRow>(LEAD_FACTS_SQL, [leadId, now])).rows[0];
  if (!row || !needsNextAction(factsOf(row))) return null;
  const spec = sweepTask(row.lifecycle_state, now);
  const { task, responsible } = await createResponsibleTask(db, row.workspace_id, leadId, spec, false);
  await addTimelineEvent(db, { leadId, kind: "task", title: NO_NEXT_ACTION_TIMELINE_TITLE, detail: spec.title, ...AUTOMATION_ACTOR, relatedTaskId: task.id });
  return { workspaceId: row.workspace_id, taskId: task.id, notify: responsible.notify, title: spec.title };
}

/** Worker job (every 15 min): rule 3. Bells batched: one per person per workspace per tick. */
export async function runNextActionSweep(opts: SweepOptions = {}): Promise<{ leadId: string; taskId: string }[]> {
  const now = opts.now ?? new Date();
  const candidates = (
    await pool.query<{ id: string; workspace_id: string }>(SWEEP_CANDIDATES_SQL, [now, opts.workspaceIds ?? null, opts.since ?? null, opts.perWorkspace ?? PER_WORKSPACE, TICK_LIMIT])
  ).rows;
  const created: { leadId: string; taskId: string; workspaceId: string; notify: string[]; title: string }[] = [];
  for (const c of candidates) {
    const done = await withTransaction((db) => sweepLead(db, c.id, now));
    if (done) created.push({ leadId: c.id, ...done });
  }
  await sendSweepBells(pool, created);
  return created.map(({ leadId, taskId }) => ({ leadId, taskId }));
}

/** Rule 3 bells: "3 leads need a next step", linking to the open tasks of that title (or all open tasks when mixed). */
export async function sendSweepBells(db: Queryable, created: { workspaceId: string; notify: string[]; title: string }[]): Promise<number> {
  const bells = batchBells(created);
  for (const bell of bells) {
    const titles = new Set(created.filter((c) => c.workspaceId === bell.workspaceId && c.notify.includes(bell.recipientId)).map((c) => c.title));
    const href = titles.size === 1 ? `/tasks?status=open&q=${encodeURIComponent([...titles][0]!)}` : "/tasks?status=open";
    await notifyUsers(db, bell.workspaceId, [bell.recipientId], null, {
      title: sweepBellTitle(bell.count),
      detail: "These leads had no open task, meeting or automation, so a task was created for each.",
      kind: "warning",
      href,
    });
  }
  return bells.length;
}

/** Rule 4 CLI dry run: per-workspace counts, nothing written. */
export async function countNextActionSweep(db: Queryable, opts: SweepOptions = {}): Promise<{ workspaceId: string; workspaceName: string; count: number }[]> {
  const rows = (
    await db.query<{ workspace_id: string; workspace_name: string; count: number }>(SWEEP_COUNTS_SQL, [opts.now ?? new Date(), opts.workspaceIds ?? null, opts.since ?? null])
  ).rows;
  return rows.map((r) => ({ workspaceId: r.workspace_id, workspaceName: r.workspace_name, count: r.count }));
}
