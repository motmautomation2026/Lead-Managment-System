/**
 * LL-3 rule 9: proposal validity, deal decision dates and the 10-day manager review. Every SQL query of the feature
 * lives here; the dates and titles are pure (domain/dealFollowUp.ts). One worker step (`deal_follow_ups`), each kind
 * fair across workspaces and bounded, each row in its own transaction with a locked re-check and a once-only marker:
 * - proposal sent, 3 working days before `valid_until` → owner task "Proposal expires <date> — follow up" (expiry_warned_at);
 * - proposal still sent after `valid_until` → owner task "Proposal expired — revise or close" (expired_task_at);
 * - deal in negotiation after its `next_decision_date` → owner task "Decision date passed: <deal>" (decision_task_for);
 * - deal in proposal / negotiation with no stage change, call, note, meeting or message for > 10 days → unowned
 *   "Manager review: <deal>" task + bell for the workspace admins, once per 10-day period (review_task_at).
 * Tasks only for live leads (active / long-term nurture, not merged); the marker is set either way.
 */
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import {
  datePassed,
  decisionOverdueTitle,
  expiryWarningAt,
  managerReviewTitle,
  needsManagerReview,
  PROPOSAL_EXPIRED_TITLE,
  proposalExpiringTitle,
} from "../domain/dealFollowUp.js";
import { fairPickSql } from "./fairPick.js";
import { createResponsibleTask, notifyUsers } from "./nextAction.service.js";
import { createTask } from "./tasks.service.js";
import { WORKSPACE_ADMIN_IDS_SQL } from "./profiles.service.js";
import { AUTOMATED_SQL } from "./leadAutomation.service.js";

/** P7: per kind and tick, round-robin across workspaces. */
const TICK_LIMIT = 100;
const LIVE_LEAD = `l.lifecycle_state in ('active', 'long_term_nurture') and l.merged_into_lead_id is null`;
const IST_TODAY = `(now() at time zone 'Asia/Kolkata')::date`;

/** $1 workspace ids (null = all), $2 limit. Sent proposals whose expiry warning may be due (≤ 4 calendar days ahead covers 3 working days). */
export const EXPIRING_CANDIDATES_SQL = `select p.id, p.valid_until::text as valid_until from public.proposals p where p.id in (${fairPickSql({
  from: "public.proposals x",
  where: `x.status = 'sent' and x.valid_until is not null and x.expiry_warned_at is null and x.valid_until <= ${IST_TODAY} + 4
    and x.valid_until >= ${IST_TODAY} and ($1::uuid[] is null or x.workspace_id = any($1::uuid[]))
    and exists (select 1 from public.leads al where al.id = x.lead_id and ${AUTOMATED_SQL("al")})`,
  order: "x.valid_until",
  limit: "$2",
})})`;

/** $1 workspace ids, $2 limit. Sent proposals past their valid-until date with no decision. */
export const EXPIRED_CANDIDATES_SQL = `select p.id from public.proposals p where p.id in (${fairPickSql({
  from: "public.proposals x",
  where: `x.status = 'sent' and x.valid_until is not null and x.expired_task_at is null and x.valid_until < ${IST_TODAY}
    and ($1::uuid[] is null or x.workspace_id = any($1::uuid[]))
    and exists (select 1 from public.leads al where al.id = x.lead_id and ${AUTOMATED_SQL("al")})`,
  order: "x.valid_until",
  limit: "$2",
})})`;

/** $1 proposal id: locked re-check + what the task needs. */
export const PROPOSAL_ROW_SQL = `select p.id, p.workspace_id, p.lead_id, p.owner_id, p.status, p.valid_until::text as valid_until,
       p.expiry_warned_at, p.expired_task_at, (${LIVE_LEAD}) as live
  from public.proposals p join public.leads l on l.id = p.lead_id and l.workspace_id = p.workspace_id
 where p.id = $1 for update of p`;

/** $1 workspace ids, $2 limit. Negotiation deals past their decision date, no task yet for that date. */
export const DECISION_CANDIDATES_SQL = `select d.id from public.deals d where d.id in (${fairPickSql({
  from: "public.deals x",
  where: `x.stage = 'negotiation' and x.next_decision_date is not null and x.next_decision_date < ${IST_TODAY}
    and x.decision_task_for is distinct from x.next_decision_date and ($1::uuid[] is null or x.workspace_id = any($1::uuid[]))
    and exists (select 1 from public.leads al where al.id = x.lead_id and ${AUTOMATED_SQL("al")})`,
  order: "x.next_decision_date",
  limit: "$2",
})})`;

/** The deal's last activity: stage change, or the lead's latest call, note, meeting, message out or reply in. */
const LAST_ACTIVITY = `greatest(d.stage_changed_at,
    (select max(c.created_at) from public.calls c where c.lead_id = d.lead_id),
    (select max(n.created_at) from public.lead_notes n where n.lead_id = d.lead_id),
    (select max(m.created_at) from public.meetings m where m.lead_id = d.lead_id),
    (select max(f.sent_at) from public.message_facts f where f.lead_id = d.lead_id),
    (select max(i.received_at) from public.whatsapp_inbound_events i where i.lead_id = d.lead_id),
    (select max(e.received_at) from public.email_inbound_events e where e.lead_id = d.lead_id and e.match_status = 'matched'))`;

/** $1 workspace ids, $2 limit, $3 now. Open proposal / negotiation deals idle on the stage side > 10 days (activity re-checked per deal). */
export const REVIEW_CANDIDATES_SQL = `select d.id from public.deals d where d.id in (${fairPickSql({
  from: "public.deals x",
  where: `x.stage in ('proposal_sent', 'negotiation') and x.stage_changed_at < $3::timestamptz - interval '10 days'
    and (x.review_task_at is null or x.review_task_at <= $3::timestamptz - interval '10 days')
    and ($1::uuid[] is null or x.workspace_id = any($1::uuid[]))
    and exists (select 1 from public.leads al where al.id = x.lead_id and ${AUTOMATED_SQL("al")})`,
  order: "x.stage_changed_at",
  limit: "$2",
})})`;

/** $1 deal id: locked re-check + what the tasks need. */
export const DEAL_ROW_SQL = `select d.id, d.workspace_id, d.lead_id, d.owner_id, d.name, d.stage, d.next_decision_date::text as next_decision_date,
       d.decision_task_for::text as decision_task_for, d.review_task_at, ${LAST_ACTIVITY} as last_activity_at, (${LIVE_LEAD}) as live
  from public.deals d join public.leads l on l.id = d.lead_id and l.workspace_id = d.workspace_id
 where d.id = $1 for update of d`;

interface ProposalRow {
  id: string;
  workspace_id: string;
  lead_id: string;
  owner_id: string | null;
  status: string;
  valid_until: string | null;
  expiry_warned_at: Date | null;
  expired_task_at: Date | null;
  live: boolean;
}

interface DealRow {
  id: string;
  workspace_id: string;
  lead_id: string;
  owner_id: string | null;
  name: string;
  stage: string;
  next_decision_date: string | null;
  decision_task_for: string | null;
  review_task_at: Date | null;
  last_activity_at: Date;
  live: boolean;
}

export async function proposalExpiring(db: Queryable, id: string, now: Date): Promise<boolean> {
  const p = (await db.query<ProposalRow>(PROPOSAL_ROW_SQL, [id])).rows[0];
  if (!p || p.status !== "sent" || !p.valid_until || p.expiry_warned_at || expiryWarningAt(p.valid_until) > now || datePassed(p.valid_until, now)) return false;
  await db.query(`update public.proposals set expiry_warned_at = $2 where id = $1`, [id, now]);
  if (p.live) {
    await createResponsibleTask(db, p.workspace_id, p.lead_id, { type: "proposal_follow_up", title: proposalExpiringTitle(p.valid_until), dueAt: now, marker: "proposal_expiring", ownerHint: p.owner_id });
  }
  return true;
}

export async function proposalExpired(db: Queryable, id: string, now: Date): Promise<boolean> {
  const p = (await db.query<ProposalRow>(PROPOSAL_ROW_SQL, [id])).rows[0];
  if (!p || p.status !== "sent" || !p.valid_until || p.expired_task_at || !datePassed(p.valid_until, now)) return false;
  await db.query(`update public.proposals set expired_task_at = $2 where id = $1`, [id, now]);
  if (p.live) {
    await createResponsibleTask(db, p.workspace_id, p.lead_id, { type: "proposal_follow_up", title: PROPOSAL_EXPIRED_TITLE, dueAt: now, marker: "proposal_expired", ownerHint: p.owner_id });
  }
  return true;
}

export async function decisionOverdue(db: Queryable, id: string, now: Date): Promise<boolean> {
  const d = (await db.query<DealRow>(DEAL_ROW_SQL, [id])).rows[0];
  if (!d || d.stage !== "negotiation" || !d.next_decision_date || d.decision_task_for === d.next_decision_date || !datePassed(d.next_decision_date, now)) return false;
  await db.query(`update public.deals set decision_task_for = next_decision_date where id = $1`, [id]);
  if (d.live) {
    await createResponsibleTask(db, d.workspace_id, d.lead_id, { type: "follow_up", title: decisionOverdueTitle(d.name), dueAt: now, marker: "decision_overdue", ownerHint: d.owner_id });
  }
  return true;
}

export async function managerReview(db: Queryable, id: string, now: Date): Promise<boolean> {
  const d = (await db.query<DealRow>(DEAL_ROW_SQL, [id])).rows[0];
  if (!d || !["proposal_sent", "negotiation"].includes(d.stage) || !needsManagerReview(d.last_activity_at, d.review_task_at, now)) return false;
  await db.query(`update public.deals set review_task_at = $2 where id = $1`, [id, now]);
  if (!d.live) return true;
  const title = managerReviewTitle(d.name);
  await createTask(db, null, d.workspace_id, { leadId: d.lead_id, ownerId: null, type: "internal_review", title, dueAt: now.toISOString(), marker: "manager_review" });
  const admins = (await db.query<{ ids: string[] }>(`select array(${WORKSPACE_ADMIN_IDS_SQL}) as ids`, [d.workspace_id])).rows[0]?.ids ?? [];
  await notifyUsers(db, d.workspace_id, admins, d.lead_id, { title, detail: "No stage change, call, note, meeting or message for over 10 days.", kind: "warning", href: `/deals/${d.id}` });
  return true;
}

/** Worker step `deal_follow_ups`: the four kinds, each bounded and fair. Returns how many rows got their marker. */
export async function runDealFollowUps(opts: { now?: Date; workspaceIds?: string[] } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const ws = opts.workspaceIds ?? null;
  let done = 0;
  const each = async (sql: string, params: unknown[], fn: (db: Queryable, id: string, now: Date) => Promise<boolean>) => {
    for (const row of (await pool.query<{ id: string }>(sql, params)).rows) if (await withTransaction((db) => fn(db, row.id, now))) done++;
  };
  await each(EXPIRING_CANDIDATES_SQL, [ws, TICK_LIMIT], proposalExpiring);
  await each(EXPIRED_CANDIDATES_SQL, [ws, TICK_LIMIT], proposalExpired);
  await each(DECISION_CANDIDATES_SQL, [ws, TICK_LIMIT], decisionOverdue);
  await each(REVIEW_CANDIDATES_SQL, [ws, TICK_LIMIT, now], managerReview);
  return done;
}
