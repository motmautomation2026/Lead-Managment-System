import { z } from "zod";
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { AGENT_ACTOR_NAME } from "../agent/constants.js";
import { multi, pageParams, runPage, SqlBuilder, type ListSort } from "../lists/listQuery.js";

export type ActorSource = "manual" | "automation" | "system";

export interface AddTimelineEventInput {
  leadId: string;
  kind: string;
  title: string;
  detail?: string | null;
  actorId?: string | null;
  actorName: string;
  actorSource: ActorSource;
  relatedTaskId?: string | null;
  relatedMeetingId?: string | null;
  relatedProposalId?: string | null;
  relatedCallId?: string | null;
  relatedWorkflowRunId?: string | null;
  relatedDealId?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt?: Date;
}

/**
 * Every business-meaningful change appends here (Rule 5: every important
 * state change stays historically traceable). Append-only by design — the
 * table has no update/delete RLS policy either.
 */
export async function addTimelineEvent(db: Queryable, input: AddTimelineEventInput) {
  await db.query(
    `insert into public.timeline_events
      (lead_id, occurred_at, event_kind, title, detail, actor_id, actor_name, actor_source,
       related_task_id, related_meeting_id, related_proposal_id, related_call_id,
       related_workflow_run_id, metadata, related_deal_id)
     values ($1, coalesce($2, now()), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      input.leadId,
      input.occurredAt ?? null,
      input.kind,
      input.title,
      input.detail ?? null,
      input.actorId ?? null,
      input.actorName,
      input.actorSource,
      input.relatedTaskId ?? null,
      input.relatedMeetingId ?? null,
      input.relatedProposalId ?? null,
      input.relatedCallId ?? null,
      input.relatedWorkflowRunId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.relatedDealId ?? null,
    ],
  );
}

export function actorEvent(actor: Actor): { actorId: string; actorName: string; actorSource: "manual" } {
  return { actorId: actor.id, actorName: actor.fullName, actorSource: "manual" };
}

export const SYSTEM_ACTOR = { actorId: null, actorName: "System", actorSource: "system" as const };
export const AUTOMATION_ACTOR = { actorId: null, actorName: "Automation", actorSource: "automation" as const };

interface TimelineRow {
  id: string;
  lead_id: string;
  occurred_at: Date;
  event_kind: string;
  title: string;
  detail: string | null;
  actor_id: string | null;
  actor_name: string;
  actor_source: string;
  related_task_id: string | null;
  related_meeting_id: string | null;
  related_proposal_id: string | null;
  related_call_id: string | null;
  related_workflow_run_id: string | null;
  related_deal_id: string | null;
  metadata: Record<string, unknown> | null;
}

export function timelineToDto(row: TimelineRow) {
  return {
    id: row.id,
    leadId: row.lead_id,
    at: row.occurred_at.toISOString(),
    kind: row.event_kind,
    title: row.title,
    detail: row.detail ?? undefined,
    actor: row.actor_name,
    actorId: row.actor_id ?? undefined,
    source: row.actor_source,
    relatedTaskId: row.related_task_id ?? undefined,
    relatedMeetingId: row.related_meeting_id ?? undefined,
    relatedProposalId: row.related_proposal_id ?? undefined,
    relatedCallId: row.related_call_id ?? undefined,
    relatedWorkflowRunId: row.related_workflow_run_id ?? undefined,
    relatedDealId: row.related_deal_id ?? undefined,
    metadata: row.metadata ?? undefined,
  };
}

export async function listTimelineForLead(db: Queryable, workspaceId: string, leadId: string) {
  const result = await db.query<TimelineRow>(
    `select t.*
       from public.timeline_events t
       join public.leads l on l.id = t.lead_id
      where t.lead_id = $1 and l.workspace_id = $2
      order by t.occurred_at asc`,
    [leadId, workspaceId],
  );
  return result.rows.map(timelineToDto);
}

// --- Paginated timelines (C3): the list standard, newest first ---------------------

/** Activity filter groups, the same chips as the record pages' Activity tab. */
export const ACTIVITY_TYPES = ["notes", "calls", "meetings", "tasks", "messages", "ai", "deals", "system"] as const;

// One group per row, first match wins: deal rows, then AI agent rows, then by kind. `agent` binds AGENT_ACTOR_NAME.
const activityTypeSql = (agent: string) => `case
  when t.related_deal_id is not null then 'deals'
  when t.actor_name = ${agent} then 'ai'
  when t.event_kind = 'note' then 'notes'
  when t.event_kind = 'call' then 'calls'
  when t.event_kind in ('meeting', 'proposal') then 'meetings'
  when t.event_kind = 'task' then 'tasks'
  when t.event_kind in ('email', 'whatsapp') then 'messages'
  else 'system' end`;

// Always newest first (no sort param); index (lead_id, occurred_at, id), migration 035.
const TIMELINE_SORT: ListSort = { key: "at", dir: "desc", field: { columns: ["t.occurred_at"], type: "timestamptz" }, idColumn: "t.id" };

/** GET /contacts/:id/timeline and /companies/:id/timeline. */
export const timelineListSchema = z.object({ kind: multi(z.enum(ACTIVITY_TYPES)).optional(), ...pageParams }).strict();
type TimelineQuery = z.infer<typeof timelineListSchema>;

function timelinePage<R extends TimelineRow>(db: Queryable, b: SqlBuilder, query: TimelineQuery, extraSelect = "") {
  if (query.kind) b.and(`${activityTypeSql(b.p(AGENT_ACTOR_NAME))} = any(${b.p(query.kind)}::text[])`);
  return runPage<R>(db, b, TIMELINE_SORT, query, ({ where, orderBy, limit, cursorSelect }) =>
    `select t.*${extraSelect}, ${cursorSelect}
       from public.timeline_events t
       join public.leads l on l.id = t.lead_id
      ${where}
      order by ${orderBy}
      limit ${limit}`,
  );
}

/** One contact's events (404 handled by the caller's lookup). */
export async function listContactTimeline(db: Queryable, workspaceId: string, leadId: string, query: TimelineQuery) {
  const b = new SqlBuilder();
  b.and(`l.workspace_id = ${b.p(workspaceId)}`).and(`t.lead_id = ${b.p(leadId)}`);
  const page = await timelinePage(db, b, query);
  return { data: page.data.map(timelineToDto), nextCursor: page.nextCursor };
}

/** Events of the company's non-merged contacts plus every event of its deals, each with whose event it is. */
export async function listCompanyTimeline(db: Queryable, workspaceId: string, companyId: string, query: TimelineQuery) {
  const b = new SqlBuilder();
  const ws = b.p(workspaceId);
  const company = b.p(companyId);
  b.and(`l.workspace_id = ${ws}`).and(
    `((l.company_id = ${company} and l.lifecycle_state <> 'merged')
      or t.related_deal_id in (select d.id from public.deals d where d.workspace_id = ${ws} and d.company_id = ${company}))`,
  );
  const page = await timelinePage<TimelineRow & { contact: { id: string; name: string } }>(
    db,
    b,
    query,
    `, json_build_object('id', l.id, 'name', trim(l.first_name || ' ' || l.last_name)) as contact`,
  );
  return { data: page.data.map((row) => ({ ...timelineToDto(row), contact: row.contact })), nextCursor: page.nextCursor };
}
