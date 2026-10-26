/**
 * C6b automation lists on the list standard (lists/listQuery.ts): workflow runs and
 * scheduled actions ("Scheduled steps" in the UI). Read-only; run actions stay on
 * POST /runs/:id/pause|resume|cancel|retry. The old unpaginated GET /runs and
 * GET /scheduled-actions keep their shapes (deprecated, kept for the rollback).
 */
import { z } from "zod";
import type { Queryable } from "../dto.js";
import { SCHEDULED_ACTION_STATUSES, WORKFLOW_RUN_STATUSES } from "../domain/enums.js";
import {
  addRange,
  containsPattern,
  defineSorts,
  isoTimestamp,
  LEAD_FULL_NAME_SQL,
  multi,
  pageParams,
  runCount,
  runPage,
  searchQuery,
  sortParam,
  SqlBuilder,
} from "../lists/listQuery.js";
import { runToDto, scheduledActionToDto, type RunRow, type ScheduledActionRow } from "./runs.service.js";

type Ref = { id: string; name: string };
const CONTACT_JSON = `json_build_object('id', l.id, 'name', trim(l.first_name || ' ' || l.last_name))`;
const WORKFLOW_JSON = `json_build_object('id', w.id, 'name', w.name)`;

// --- Runs ----------------------------------------------------------------------

export const RUN_SORTS = defineSorts({
  idColumn: "r.id",
  defaultSort: "startedAt:desc",
  fields: { startedAt: { columns: ["r.started_at"], type: "timestamptz" } },
});

export const runFilterSchema = z
  .object({
    workflowId: z.string().uuid().optional(),
    status: multi(z.enum(WORKFLOW_RUN_STATUSES)).optional(),
    contactId: z.string().uuid().optional(),
    startedFrom: isoTimestamp.optional(),
    startedTo: isoTimestamp.optional(),
    q: searchQuery.optional(),
  })
  .strict();
export const runListSchema = runFilterSchema.extend({ ...pageParams, sort: sortParam(RUN_SORTS) }).strict();
export type RunFilters = z.infer<typeof runFilterSchema>;

const RUN_FROM = `public.workflow_runs r join public.leads l on l.id = r.lead_id`;

/** `q`: the contact's name (escaped "contains"). */
function addContactNameSearch(b: SqlBuilder, q: string | undefined) {
  if (!q) return;
  const p = b.p(containsPattern(q));
  b.and(`(${LEAD_FULL_NAME_SQL} ilike ${p} or l.first_name ilike ${p} or l.last_name ilike ${p})`);
}

function runWhere(workspaceId: string, f: RunFilters): SqlBuilder {
  const b = new SqlBuilder();
  b.and(`r.workspace_id = ${b.p(workspaceId)}`);
  if (f.workflowId) b.and(`r.workflow_id = ${b.p(f.workflowId)}`);
  if (f.status) b.and(`r.status = any(${b.p(f.status)}::public.workflow_run_status[])`);
  if (f.contactId) b.and(`r.lead_id = ${b.p(f.contactId)}`);
  addRange(b, "r.started_at", f.startedFrom, f.startedTo, "timestamptz");
  addContactNameSearch(b, f.q);
  return b;
}

/** Row = the Run DTO + `contact`, `workflow` and `currentStepAction` (the step the run is on, or null). */
export async function listRunsPage(db: Queryable, workspaceId: string, query: z.infer<typeof runListSchema>) {
  const page = await runPage<RunRow & { version_number: number; contact: Ref; workflow: Ref; current_step_action: string | null }>(
    db,
    runWhere(workspaceId, query),
    query.sort,
    query,
    ({ where, orderBy, limit, cursorSelect }) =>
      `select r.*, wv.version_number, ${CONTACT_JSON} as contact, ${WORKFLOW_JSON} as workflow, s.action as current_step_action, ${cursorSelect}
         from ${RUN_FROM}
         join public.workflow_versions wv on wv.id = r.workflow_version_id
         join public.workflows w on w.id = r.workflow_id
         left join public.workflow_steps s on s.id = r.current_step_id
        ${where}
        order by ${orderBy}
        limit ${limit}`,
  );
  return {
    ...page,
    data: page.data.map((row) => ({ ...runToDto(row, row.version_number), contact: row.contact, workflow: row.workflow, currentStepAction: row.current_step_action })),
  };
}

export const countRuns = (db: Queryable, workspaceId: string, filters: RunFilters) => runCount(db, runWhere(workspaceId, filters), RUN_FROM);

// --- Scheduled actions -----------------------------------------------------------

export const SCHEDULED_ACTION_SORTS = defineSorts({
  idColumn: "a.id",
  defaultSort: "scheduledFor:asc",
  fields: { scheduledFor: { columns: ["a.scheduled_for"], type: "timestamptz" } },
});

export const scheduledActionFilterSchema = z
  .object({
    status: multi(z.enum(SCHEDULED_ACTION_STATUSES)).optional(),
    runId: z.string().uuid().optional(),
    workflowId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    dueFrom: isoTimestamp.optional(),
    dueTo: isoTimestamp.optional(),
    q: searchQuery.optional(),
  })
  .strict();
export const scheduledActionListSchema = scheduledActionFilterSchema.extend({ ...pageParams, sort: sortParam(SCHEDULED_ACTION_SORTS) }).strict();
export type ScheduledActionFilters = z.infer<typeof scheduledActionFilterSchema>;

const ACTION_FROM = `public.scheduled_actions a join public.workflow_runs r on r.id = a.workflow_run_id join public.leads l on l.id = a.lead_id`;

function actionWhere(workspaceId: string, f: ScheduledActionFilters): SqlBuilder {
  const b = new SqlBuilder();
  b.and(`a.workspace_id = ${b.p(workspaceId)}`);
  if (f.status) b.and(`a.status = any(${b.p(f.status)}::public.scheduled_action_status[])`);
  if (f.runId) b.and(`a.workflow_run_id = ${b.p(f.runId)}`);
  if (f.workflowId) b.and(`r.workflow_id = ${b.p(f.workflowId)}`);
  if (f.contactId) b.and(`a.lead_id = ${b.p(f.contactId)}`);
  addRange(b, "a.scheduled_for", f.dueFrom, f.dueTo, "timestamptz");
  addContactNameSearch(b, f.q);
  return b;
}

/** Row = the scheduled action DTO + `contact`, `workflow` and `stepOrder` (0-based order in its version). */
export async function listScheduledActionsPage(db: Queryable, workspaceId: string, query: z.infer<typeof scheduledActionListSchema>) {
  const page = await runPage<ScheduledActionRow & { contact: Ref; workflow: Ref; step_order: number | null }>(
    db,
    actionWhere(workspaceId, query),
    query.sort,
    query,
    ({ where, orderBy, limit, cursorSelect }) =>
      `select a.*, ${CONTACT_JSON} as contact, ${WORKFLOW_JSON} as workflow, s.step_order, ${cursorSelect}
         from ${ACTION_FROM}
         join public.workflows w on w.id = r.workflow_id
         left join public.workflow_steps s on s.id = a.workflow_step_id
        ${where}
        order by ${orderBy}
        limit ${limit}`,
  );
  return {
    ...page,
    data: page.data.map((row) => ({ ...scheduledActionToDto(row), contact: row.contact, workflow: row.workflow, stepOrder: row.step_order })),
  };
}

export const countScheduledActions = (db: Queryable, workspaceId: string, filters: ScheduledActionFilters) =>
  runCount(db, actionWhere(workspaceId, filters), ACTION_FROM);
