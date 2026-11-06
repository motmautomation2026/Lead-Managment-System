/**
 * CRM v2 work lists (C6a): Tasks, Meetings and Proposals on the list standard
 * (lists/listQuery.ts). Read-only; writes stay on the existing /tasks, /meetings and
 * /proposals routes. "Today" / "overdue" are IST days computed in SQL, never by the client.
 * Owner names come from `profiles` (the denormalised owner_name columns are stale; audit B25/B26).
 */
import { z } from "zod";
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { MEETING_STATUSES, PROPOSAL_STATUSES, TASK_ORIGINS, TASK_TYPES } from "../domain/enums.js";
import { allowedNextProposalStatuses, lossReasonStatusesFrom, PROPOSAL_STATUS_GROUPS } from "../domain/proposalRouting.js";
import {
  addOwnerFilter,
  addRange,
  containsPattern,
  defineSorts,
  isoTimestamp,
  multi,
  ownerIdFilter,
  pageParams,
  runCount,
  runPage,
  searchQuery,
  sortParam,
  SqlBuilder,
  LEAD_FULL_NAME_SQL,
} from "../lists/listQuery.js";
import { taskToDto, type TaskRow } from "./tasks.service.js";
import { meetingToDto, type MeetingRow } from "./meetings.service.js";
import { proposalToDto, type ProposalRow } from "./proposals.service.js";

/** Start of today / tomorrow in IST as timestamptz (same expressions as the dashboard). */
const IST_DAY_START = `(date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;
const IST_NEXT_DAY_START = `((date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day') at time zone 'Asia/Kolkata')`;

type Ref = { id: string; name: string } | null;
interface RefColumns {
  contact: { id: string; name: string };
  company: Ref;
  deal: Ref;
  owner_full_name: string | null;
}

const CONTACT_JSON = `json_build_object('id', l.id, 'name', trim(l.first_name || ' ' || l.last_name))`;
const COMPANY_JSON = `case when c.id is null then null else json_build_object('id', c.id, 'name', c.name) end`;
const DEAL_JSON = `case when d.id is null then null else json_build_object('id', d.id, 'name', d.name) end`;

/** `q`: the row's title or its contact's name (escaped "contains"). */
function addTitleOrContactSearch(b: SqlBuilder, titleColumn: string, q: string | undefined) {
  if (!q) return;
  const p = b.p(containsPattern(q));
  b.and(`(${titleColumn} ilike ${p} or ${LEAD_FULL_NAME_SQL} ilike ${p} or l.first_name ilike ${p} or l.last_name ilike ${p})`);
}

const refs = (row: RefColumns) => ({ ownerName: row.owner_full_name, contact: row.contact, company: row.company, deal: row.deal });

// --- Tasks ---------------------------------------------------------------------

export const TASK_SORTS = defineSorts({
  idColumn: "t.id",
  defaultSort: "dueAt:asc",
  fields: {
    dueAt: { columns: ["t.due_at"], type: "timestamptz" },
    createdAt: { columns: ["t.created_at"], type: "timestamptz" },
    updatedAt: { columns: ["t.updated_at"], type: "timestamptz" },
    // E3b-2b "Hottest first": the contact's hot score (a joined column: no (workspace_id, field, id) index, like companies contactCount).
    hotScore: { columns: ["l.hot_score"], type: "int", nullable: true },
  },
});

/** Filters for GET /tasks/list and /tasks/count (also what a saved tasks view stores). */
export const taskFilterSchema = z
  .object({
    ownerId: ownerIdFilter.optional(),
    status: z.enum(["open", "completed", "cancelled", "all"]).optional(),
    // due_at is NOT NULL, so there is no "no due date" bucket.
    due: z.enum(["overdue", "today", "upcoming"]).optional(),
    dueFrom: isoTimestamp.optional(),
    dueTo: isoTimestamp.optional(),
    type: multi(z.enum(TASK_TYPES)).optional(),
    origin: multi(z.enum(TASK_ORIGINS)).optional(),
    contactId: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    q: searchQuery.optional(),
  })
  .strict();
export const taskSortSchema = sortParam(TASK_SORTS);
export const taskListSchema = taskFilterSchema.extend({ ...pageParams, sort: taskSortSchema }).strict();
export type TaskFilters = z.infer<typeof taskFilterSchema>;
export const TASK_COLUMNS = ["title", "type", "dueAt", "contact", "company", "deal", "owner", "origin", "status", "createdAt", "updatedAt"] as const;

const TASK_FROM = `public.tasks t join public.leads l on l.id = t.lead_id`;

function taskWhere(workspaceId: string, actor: Actor, f: TaskFilters): SqlBuilder {
  const b = new SqlBuilder();
  b.and(`t.workspace_id = ${b.p(workspaceId)}`);
  const status = f.status ?? "open";
  if (status !== "all") b.and(`t.status = ${b.p(status)}::public.task_status`);
  if (f.due === "overdue") b.and(`t.due_at < now()`);
  else if (f.due === "today") b.and(`t.due_at >= ${IST_DAY_START} and t.due_at < ${IST_NEXT_DAY_START}`);
  else if (f.due === "upcoming") b.and(`t.due_at >= ${IST_NEXT_DAY_START}`);
  addRange(b, "t.due_at", f.dueFrom, f.dueTo, "timestamptz");
  addOwnerFilter(b, "t.owner_id", f.ownerId, actor.id);
  if (f.type) b.and(`t.task_type = any(${b.p(f.type)}::public.task_type[])`);
  if (f.origin) b.and(`t.origin = any(${b.p(f.origin)}::public.task_origin[])`);
  if (f.contactId) b.and(`t.lead_id = ${b.p(f.contactId)}`);
  if (f.companyId) b.and(`l.company_id = ${b.p(f.companyId)}`);
  // Tasks carry no deal_id: a deal's tasks are its contact's.
  if (f.dealId) b.and(`t.lead_id = (select dd.lead_id from public.deals dd where dd.id = ${b.p(f.dealId)} and dd.workspace_id = t.workspace_id)`);
  addTitleOrContactSearch(b, "t.title", f.q);
  return b;
}

export async function listWorkTasks(db: Queryable, actor: Actor, workspaceId: string, query: z.infer<typeof taskListSchema>) {
  const page = await runPage<TaskRow & RefColumns & { is_overdue: boolean }>(db, taskWhere(workspaceId, actor, query), query.sort, query, ({ where, orderBy, limit, cursorSelect }) =>
    `select t.*, (t.status = 'open' and t.due_at < now()) as is_overdue,
            o.full_name as owner_full_name, ${CONTACT_JSON} as contact, ${COMPANY_JSON} as company, od.deal, ${cursorSelect}
       from ${TASK_FROM}
       left join public.companies c on c.id = l.company_id
       left join public.profiles o on o.id = t.owner_id
       left join lateral (
         select json_build_object('id', d.id, 'name', d.name) as deal
           from public.deals d where d.lead_id = t.lead_id and d.stage not in ('won', 'lost')
          order by d.updated_at desc, d.id desc limit 1) od on true
      ${where}
      order by ${orderBy}
      limit ${limit}`,
  );
  // The task's deal = the contact's most recently updated open deal (tasks are not linked to deals).
  // isOverdue: the same rule as due=overdue, so the UI never decides it.
  return { ...page, data: page.data.map((row) => ({ ...taskToDto(row), ...refs(row), isOverdue: row.is_overdue })) };
}

export const countWorkTasks = (db: Queryable, actor: Actor, workspaceId: string, filters: TaskFilters) =>
  runCount(db, taskWhere(workspaceId, actor, filters), TASK_FROM);

// --- Meetings ------------------------------------------------------------------

export const MEETING_SORTS = defineSorts({
  idColumn: "m.id",
  defaultSort: "at:asc",
  fields: {
    at: { columns: ["m.scheduled_at"], type: "timestamptz" },
    createdAt: { columns: ["m.created_at"], type: "timestamptz" },
  },
});

/** Statuses of a meeting that did not / will not happen. */
const MEETING_NOT_HELD = `('cancelled', 'no_show', 'failed')`;

export const meetingFilterSchema = z
  .object({
    ownerId: ownerIdFilter.optional(),
    status: multi(z.enum(MEETING_STATUSES)).optional(),
    // needs_outcome = in the past, held (not cancelled/no-show/failed) and no outcome yet.
    when: z.enum(["upcoming", "today", "past", "needs_outcome"]).optional(),
    from: isoTimestamp.optional(),
    to: isoTimestamp.optional(),
    contactId: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    q: searchQuery.optional(),
  })
  .strict();
export const meetingSortSchema = sortParam(MEETING_SORTS);
export const meetingListSchema = meetingFilterSchema.extend({ ...pageParams, sort: meetingSortSchema }).strict();
export type MeetingFilters = z.infer<typeof meetingFilterSchema>;
export const MEETING_COLUMNS = ["title", "at", "contact", "company", "deal", "owner", "status", "outcome", "calendar", "notify", "link", "createdAt"] as const;

const MEETING_FROM = `public.meetings m join public.leads l on l.id = m.lead_id`;

function meetingWhere(workspaceId: string, actor: Actor, f: MeetingFilters): SqlBuilder {
  const b = new SqlBuilder();
  b.and(`m.workspace_id = ${b.p(workspaceId)}`);
  if (f.status) b.and(`m.status = any(${b.p(f.status)}::public.meeting_status[])`);
  if (f.when === "upcoming") b.and(`m.scheduled_at >= now() and m.status not in ('completed', 'cancelled', 'no_show', 'failed')`);
  else if (f.when === "today") b.and(`m.scheduled_at >= ${IST_DAY_START} and m.scheduled_at < ${IST_NEXT_DAY_START}`);
  else if (f.when === "past") b.and(`m.scheduled_at < now()`);
  else if (f.when === "needs_outcome") b.and(`m.scheduled_at < now() and m.status not in ${MEETING_NOT_HELD} and m.outcome is null`);
  addRange(b, "m.scheduled_at", f.from, f.to, "timestamptz");
  addOwnerFilter(b, "m.owner_id", f.ownerId, actor.id);
  if (f.contactId) b.and(`m.lead_id = ${b.p(f.contactId)}`);
  if (f.companyId) b.and(`l.company_id = ${b.p(f.companyId)}`);
  if (f.dealId) b.and(`m.deal_id = ${b.p(f.dealId)}`);
  addTitleOrContactSearch(b, "m.title", f.q);
  return b;
}

export async function listWorkMeetings(db: Queryable, actor: Actor, workspaceId: string, query: z.infer<typeof meetingListSchema>) {
  const page = await runPage<MeetingRow & RefColumns>(db, meetingWhere(workspaceId, actor, query), query.sort, query, ({ where, orderBy, limit, cursorSelect }) =>
    `select m.*, o.full_name as owner_full_name, ${CONTACT_JSON} as contact, ${COMPANY_JSON} as company, ${DEAL_JSON} as deal, ${cursorSelect}
       from ${MEETING_FROM}
       left join public.companies c on c.id = l.company_id
       left join public.deals d on d.id = m.deal_id
       left join public.profiles o on o.id = m.owner_id
      ${where}
      order by ${orderBy}
      limit ${limit}`,
  );
  return { ...page, data: page.data.map((row) => ({ ...meetingToDto(row), ...refs(row) })) };
}

export const countWorkMeetings = (db: Queryable, actor: Actor, workspaceId: string, filters: MeetingFilters) =>
  runCount(db, meetingWhere(workspaceId, actor, filters), MEETING_FROM);

// --- Proposals -----------------------------------------------------------------

export const PROPOSAL_SORTS = defineSorts({
  idColumn: "p.id",
  defaultSort: "updatedAt:desc",
  fields: {
    updatedAt: { columns: ["p.updated_at"], type: "timestamptz" },
    sentAt: { columns: ["p.sent_at"], type: "timestamptz", nullable: true },
    amount: { columns: ["p.amount"], type: "numeric", nullable: true },
  },
});

export const proposalFilterSchema = z
  .object({
    ownerId: ownerIdFilter.optional(),
    status: multi(z.enum(PROPOSAL_STATUSES)).optional(),
    group: z.enum(["open", "awaiting_decision", "won", "lost"]).optional(),
    contactId: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    updatedFrom: isoTimestamp.optional(),
    updatedTo: isoTimestamp.optional(),
    q: searchQuery.optional(),
  })
  .strict();
export const proposalSortSchema = sortParam(PROPOSAL_SORTS);
export const proposalListSchema = proposalFilterSchema.extend({ ...pageParams, sort: proposalSortSchema }).strict();
export type ProposalFilters = z.infer<typeof proposalFilterSchema>;
export const PROPOSAL_COLUMNS = ["title", "contact", "company", "deal", "amount", "status", "sentAt", "owner", "updatedAt", "sendStatus", "document"] as const;

const PROPOSAL_FROM = `public.proposals p join public.leads l on l.id = p.lead_id`;

function proposalWhere(workspaceId: string, actor: Actor, f: ProposalFilters): SqlBuilder {
  const b = new SqlBuilder();
  b.and(`p.workspace_id = ${b.p(workspaceId)}`);
  if (f.status) b.and(`p.status = any(${b.p(f.status)}::public.proposal_status[])`);
  if (f.group) b.and(`p.status = any(${b.p(PROPOSAL_STATUS_GROUPS[f.group])}::public.proposal_status[])`);
  addOwnerFilter(b, "p.owner_id", f.ownerId, actor.id);
  if (f.contactId) b.and(`p.lead_id = ${b.p(f.contactId)}`);
  if (f.companyId) b.and(`l.company_id = ${b.p(f.companyId)}`);
  if (f.dealId) b.and(`p.deal_id = ${b.p(f.dealId)}`);
  addRange(b, "p.updated_at", f.updatedFrom, f.updatedTo, "timestamptz");
  addTitleOrContactSearch(b, "p.title", f.q);
  return b;
}

export async function listWorkProposals(db: Queryable, actor: Actor, workspaceId: string, query: z.infer<typeof proposalListSchema>) {
  const page = await runPage<ProposalRow & RefColumns>(db, proposalWhere(workspaceId, actor, query), query.sort, query, ({ where, orderBy, limit, cursorSelect }) =>
    `select p.*, o.full_name as owner_full_name, ${CONTACT_JSON} as contact, ${COMPANY_JSON} as company, ${DEAL_JSON} as deal, ${cursorSelect}
       from ${PROPOSAL_FROM}
       left join public.companies c on c.id = l.company_id
       left join public.deals d on d.id = p.deal_id
       left join public.profiles o on o.id = p.owner_id
      ${where}
      order by ${orderBy}
      limit ${limit}`,
  );
  return {
    ...page,
    data: page.data.map((row) => ({
      ...proposalToDto(row),
      ...refs(row),
      allowedNextStatuses: allowedNextProposalStatuses(row.status),
      lossReasonStatuses: lossReasonStatusesFrom(row.status),
    })),
  };
}

export const countWorkProposals = (db: Queryable, actor: Actor, workspaceId: string, filters: ProposalFilters) =>
  runCount(db, proposalWhere(workspaceId, actor, filters), PROPOSAL_FROM);

/** Page-header stats with the list's filters: open count, sent count, open value (INR only). */
export async function proposalSummary(db: Queryable, actor: Actor, workspaceId: string, filters: ProposalFilters) {
  const b = proposalWhere(workspaceId, actor, filters);
  const open = b.p(PROPOSAL_STATUS_GROUPS.open);
  const { rows } = await db.query<{ openCount: number; sentCount: number; openValue: number }>(
    `select count(*) filter (where p.status = any(${open}::public.proposal_status[]))::int as "openCount",
            count(*) filter (where p.status = 'sent')::int as "sentCount",
            coalesce(sum(p.amount) filter (where p.status = any(${open}::public.proposal_status[]) and p.currency = 'INR'), 0)::float8 as "openValue"
       from ${PROPOSAL_FROM} ${b.where()}`,
    b.params,
  );
  return rows[0] ?? { openCount: 0, sentCount: 0, openValue: 0 };
}
