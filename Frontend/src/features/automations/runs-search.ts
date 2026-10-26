import { z } from "zod";
import type { FilterValues } from "@/components/crm/filter-model";
import type { SortState } from "@/components/crm/data-table";
import { day, dayEnd, dayStart } from "@/features/contacts/contacts-search";
import {
  RUN_STATUSES,
  SCHEDULED_ACTION_STATUSES,
  type RunListParams,
  type ScheduledActionListParams,
} from "@/types";

/**
 * /automations/runs URL state. `tab` picks Runs (GET /runs/list) or Scheduled steps
 * (GET /scheduled-actions/list); the rest are those endpoints' params. `from`/`to` are whole
 * IST days: the run's start on Runs, the step's due time on Scheduled steps.
 */
export const runsSearchSchema = z.object({
  tab: z.enum(["runs", "steps"]).optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  workflowId: z.string().optional(),
  runStatus: z.array(z.enum(RUN_STATUSES)).optional(),
  stepStatus: z.array(z.enum(SCHEDULED_ACTION_STATUSES)).optional(),
  contactId: z.string().optional(),
  runId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type RunsSearch = z.infer<typeof runsSearchSchema>;

export const validateRunsSearch = (search: Record<string, unknown>): RunsSearch => {
  const parsed = runsSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};

const DEFAULT_SORT = { runs: "startedAt:desc", steps: "scheduledFor:asc" } as const;

const searchTerm = (q: string | undefined) => {
  const t = q?.trim();
  return t && t.length >= 2 ? t : undefined;
};

export function toRunParams(state: RunsSearch): RunListParams {
  return {
    workflowId: state.workflowId,
    status: state.runStatus,
    contactId: state.contactId,
    startedFrom: state.from,
    startedTo: state.to,
    q: searchTerm(state.q),
    sort: state.tab === "steps" ? DEFAULT_SORT.runs : (state.sort ?? DEFAULT_SORT.runs),
  };
}

export function toStepParams(state: RunsSearch): ScheduledActionListParams {
  return {
    workflowId: state.workflowId,
    status: state.stepStatus,
    contactId: state.contactId,
    runId: state.runId,
    dueFrom: state.from,
    dueTo: state.to,
    q: searchTerm(state.q),
    sort: state.tab === "steps" ? (state.sort ?? DEFAULT_SORT.steps) : DEFAULT_SORT.steps,
  };
}

export function parseSort(state: RunsSearch): SortState {
  const tab = state.tab ?? "runs";
  const [field, dir] = (state.sort ?? DEFAULT_SORT[tab]).split(":");
  return { field: field ?? "", dir: dir === "desc" ? "desc" : "asc" };
}

export function toFilterValues(state: RunsSearch): FilterValues {
  return {
    status: state.tab === "steps" ? state.stepStatus : state.runStatus,
    workflowId: state.workflowId ? [state.workflowId] : undefined,
    dateRange: state.from || state.to ? { from: day(state.from), to: day(state.to) } : undefined,
  };
}

type Range = { from?: string | undefined; to?: string | undefined } | undefined;

export function fromFilterValues(state: RunsSearch, values: FilterValues): Partial<RunsSearch> {
  const status = values["status"] as string[] | undefined;
  // The API takes one workflow: the last one picked wins.
  const workflows = values["workflowId"] as string[] | undefined;
  const range = values["dateRange"] as Range;
  return {
    ...(state.tab === "steps"
      ? { stepStatus: status?.length ? (status as RunsSearch["stepStatus"]) : undefined }
      : { runStatus: status?.length ? (status as RunsSearch["runStatus"]) : undefined }),
    workflowId: workflows?.length ? workflows[workflows.length - 1] : undefined,
    from: range?.from ? dayStart(range.from) : undefined,
    to: range?.to ? dayEnd(range.to) : undefined,
  };
}
