/**
 * E3b-2a worker reminders (every tick, no flag; batched per workspace):
 * - rule 5: a reply task still open 2 working hours (the workspace's AI send window, IST) after the
 *   reply → one notification to the admins, once per task (`tasks.escalated_at`);
 * - rule 7a: a meeting 2 days past with no outcome → one owner task "Log the meeting outcome", once per
 *   meeting (`meetings.outcome_task_created_at`).
 * E3b-2a-2 rule 2: both act only on tasks / meetings created at or after `agent_settings.reminders_since`
 * (migration 052's apply time), so a deploy never floods admins and owners about old work.
 */
import { pool, withTransaction } from "../db.js";
import { WORKSPACE_ADMIN_IDS_SQL } from "./profiles.service.js";
import { REPLY_TASK_TITLES } from "../agent/replyClassification.js";
import { escalationDue } from "../domain/replyDrafts.js";
import { DEFAULT_SEND_WINDOW, type SendWindow } from "../domain/whatsappSafety.js";
import { createResponsibleTask } from "./nextAction.service.js";
import { endOfIstDay } from "./whatsapp-inbound.service.js";
import { fairPickSql } from "./fairPick.js";

const PER_WORKSPACE = 20;
const MEETING_BATCH = 50;
/** P7: at most this many reply tasks are looked at per tick across all workspaces. */
const TICK_LIMIT = 100;
export const MEETING_OUTCOME_TASK_TITLE = "Log the meeting outcome";

interface EscalationCandidate {
  id: string;
  workspace_id: string;
  lead_id: string;
  owner_id: string | null;
  created_at: Date;
  rep_name: string | null;
  first_name: string | null;
  last_name: string | null;
  send_days: number[] | null;
  send_window_start: string | null;
  send_window_end: string | null;
}

/**
 * Oldest first per workspace (at most 20 each): the deadline grows with created_at, so when the
 * oldest isn't due, no newer one is. The update is the claim (escalated_at is null), so it is once.
 */
export async function runReplyEscalation(opts: { now?: Date; workspaceIds?: string[] } = {}): Promise<string[]> {
  const now = opts.now ?? new Date();
  const candidates = (
    await pool.query<EscalationCandidate>(
      `select t.id, t.workspace_id, t.lead_id, t.owner_id, t.created_at, coalesce(p.full_name, t.owner_name) as rep_name, l.first_name, l.last_name,
              s.send_days, s.send_window_start::text as send_window_start, s.send_window_end::text as send_window_end
         from (select t.*, row_number() over (partition by t.workspace_id order by t.created_at) as rn
                 from public.tasks t
                 join public.agent_settings rs on rs.workspace_id = t.workspace_id and t.created_at >= rs.reminders_since
                where t.status = 'open' and t.origin = 'agent' and t.escalated_at is null and t.title = any($1::text[])
                  and t.created_at < $2::timestamptz - interval '2 hours'
                  and ($3::uuid[] is null or t.workspace_id = any($3::uuid[]))) t
         join public.leads l on l.id = t.lead_id
         left join public.profiles p on p.id = t.owner_id
         left join public.agent_settings s on s.workspace_id = t.workspace_id
        where t.rn <= $4
        -- P7: also at most TICK_LIMIT per tick in all, round-robin (every workspace's oldest first).
        order by t.rn, t.created_at
        limit $5`,
      [REPLY_TASK_TITLES, now, opts.workspaceIds ?? null, PER_WORKSPACE, TICK_LIMIT],
    )
  ).rows;
  const escalated: string[] = [];
  for (const c of candidates) {
    const window: SendWindow =
      c.send_days && c.send_window_start && c.send_window_end ? { days: c.send_days, start: c.send_window_start.slice(0, 5), end: c.send_window_end.slice(0, 5) } : DEFAULT_SEND_WINDOW;
    if (!escalationDue(c.created_at, now, window)) continue;
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "a contact";
    const done = await withTransaction(async (db) => {
      const claimed = await db.query(`update public.tasks set escalated_at = now() where id = $1 and escalated_at is null and status = 'open' returning id`, [c.id]);
      if (!claimed.rowCount) return false;
      await db.query(
        `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, lead_id, href)
         select $1, a.user_id, $2, $3, 'warning', $4, $5 from (${WORKSPACE_ADMIN_IDS_SQL}) a`,
        [c.workspace_id, c.owner_id ? `${c.rep_name ?? "The owner"} hasn't answered ${name}'s reply yet (2 h)` : `Nobody has answered ${name}'s reply yet (2 h, no owner)`, "The reply task is still open 2 working hours after the reply.", c.lead_id, `/contacts/${c.lead_id}`],
      );
      return true;
    });
    if (done) escalated.push(c.id);
  }
  return escalated;
}

/**
 * Meetings 2–30 days past (older ones are history, not a reminder) with no outcome and not cancelled /
 * no-show / failed. The marker is set in the same transaction as the task, so it is once per meeting.
 */
export async function runMeetingOutcomeTasks(opts: { workspaceIds?: string[] } = {}): Promise<string[]> {
  return withTransaction(async (db) => {
    const meetings = (
      await db.query<{ id: string; workspace_id: string; lead_id: string; owner_id: string | null; title: string }>(
        `select m.id, m.workspace_id, m.lead_id, coalesce(m.owner_id, l.owner_id) as owner_id, m.title
           from public.meetings m
           join public.leads l on l.id = m.lead_id and l.merged_into_lead_id is null
           join public.agent_settings rs on rs.workspace_id = m.workspace_id and m.created_at >= rs.reminders_since
          where m.id in (${fairPickSql({
            from: "public.meetings x join public.agent_settings rs on rs.workspace_id = x.workspace_id and x.created_at >= rs.reminders_since",
            where: `x.outcome is null and x.outcome_task_created_at is null
            and x.status::text not in ('cancelled', 'no_show', 'failed')
            and x.scheduled_at < now() - interval '2 days' and x.scheduled_at > now() - interval '30 days'
            and ($1::uuid[] is null or x.workspace_id = any($1::uuid[]))`,
            order: "x.scheduled_at",
            limit: "$2",
          })})
            -- P7: round-robin across workspaces; repeated so the lock re-checks the latest row.
            and m.outcome is null and m.outcome_task_created_at is null
          for update of m skip locked`,
        [opts.workspaceIds ?? null, MEETING_BATCH],
      )
    ).rows;
    for (const m of meetings) {
      await db.query(`update public.meetings set outcome_task_created_at = now() where id = $1`, [m.id]);
      // LL-1 rule 1: the meeting's (else the lead's) owner if an active member, else unowned + the admins' bell.
      await createResponsibleTask(db, m.workspace_id, m.lead_id, { type: "follow_up", title: MEETING_OUTCOME_TASK_TITLE, dueAt: endOfIstDay(), ownerHint: m.owner_id });
    }
    return meetings.map((m) => m.id);
  });
}
