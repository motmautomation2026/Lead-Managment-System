import { z } from "zod";
import type { FilterValues } from "@/components/crm/filter-model";
import type { SortState } from "@/components/crm/data-table";
import { day, dayEnd, dayStart } from "@/features/contacts/contacts-search";
import type { BuiltInView, ListViewSpec } from "@/features/crm/saved-views";
import { TASK_TYPES, type TaskListParams } from "@/types";

const list = z.array(z.string()).optional();
const ORIGINS = ["manual", "automation", "agent"] as const;
const STATUSES = ["open", "completed", "cancelled", "all"] as const;

/**
 * /tasks URL state. Filter keys are the GET /tasks/list param names, so a URL and a saved
 * view's `filters` are interchangeable. `due` (overdue / today / upcoming) is decided by the
 * backend in IST; the page only passes it.
 */
export const tasksSearchSchema = z.object({
  view: z.string().optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  columns: list,
  ownerId: list,
  status: z.enum(STATUSES).optional(),
  due: z.enum(["overdue", "today", "upcoming"]).optional(),
  dueFrom: z.string().optional(),
  dueTo: z.string().optional(),
  type: z.array(z.enum(TASK_TYPES)).optional(),
  origin: z.array(z.enum(ORIGINS)).optional(),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  dealId: z.string().optional(),
});
export type TasksSearch = z.infer<typeof tasksSearchSchema>;

export const validateTasksSearch = (search: Record<string, unknown>): TasksSearch => {
  const parsed = tasksSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};

const MULTI_KEYS = ["ownerId", "type", "origin"] as const;
const FILTER_KEYS = [
  ...MULTI_KEYS,
  "status",
  "due",
  "dueFrom",
  "dueTo",
  "contactId",
  "companyId",
  "dealId",
  "q",
] as const;

export const NO_FILTERS = Object.fromEntries(
  [...FILTER_KEYS, "sort", "columns"].map((k) => [k, undefined]),
) as Partial<TasksSearch>;

export const DEFAULT_SORT = "dueAt:asc";
export const DEFAULT_COLUMNS = ["title", "type", "dueAt", "contact", "company", "owner", "origin"];

/** API params for GET /tasks/list (+ /count): q only from 2 characters. */
export function toApiParams(state: TasksSearch): TaskListParams {
  const params: TaskListParams = {};
  for (const key of FILTER_KEYS)
    if (state[key] !== undefined) Object.assign(params, { [key]: state[key] });
  const q = state.q?.trim();
  params.q = q && q.length >= 2 ? q : undefined;
  params.sort = state.sort ?? DEFAULT_SORT;
  return params;
}

export function parseSort(sort: string | undefined): SortState {
  const [field, dir] = (sort ?? DEFAULT_SORT).split(":");
  return { field: field ?? "dueAt", dir: dir === "desc" ? "desc" : "asc" };
}

export function toFilterValues(state: TasksSearch): FilterValues {
  return {
    ownerId: state.ownerId,
    type: state.type,
    origin: state.origin,
    status: state.status ? [state.status] : undefined,
    dueRange:
      state.dueFrom || state.dueTo ? { from: day(state.dueFrom), to: day(state.dueTo) } : undefined,
  };
}

type Range = { from?: string | undefined; to?: string | undefined } | undefined;

export function fromFilterValues(values: FilterValues): Partial<TasksSearch> {
  const multi = <T extends string>(k: string) => {
    const v = values[k] as T[] | undefined;
    return v?.length ? v : undefined;
  };
  const range = values["dueRange"] as Range;
  // Status is single-valued in the API: the last picked option wins.
  const status = multi<(typeof STATUSES)[number]>("status");
  return {
    ownerId: multi("ownerId"),
    type: multi<(typeof TASK_TYPES)[number]>("type"),
    origin: multi<(typeof ORIGINS)[number]>("origin"),
    status: status?.[status.length - 1],
    dueFrom: range?.from ? dayStart(range.from) : undefined,
    dueTo: range?.to ? dayEnd(range.to) : undefined,
  };
}

/** Views are the viewer's own work except "All open" (the owner filter can always change that). */
export const BUILT_IN_VIEWS: BuiltInView<TasksSearch>[] = [
  { id: "mine", label: "My open", state: () => ({ ownerId: ["me"] }) },
  { id: "overdue", label: "Overdue", state: () => ({ ownerId: ["me"], due: "overdue" }) },
  { id: "today", label: "Due today", state: () => ({ ownerId: ["me"], due: "today" }) },
  { id: "upcoming", label: "Upcoming", state: () => ({ ownerId: ["me"], due: "upcoming" }) },
  {
    id: "completed",
    label: "Completed",
    state: () => ({ ownerId: ["me"], status: "completed", sort: "updatedAt:desc" }),
  },
  // Not "all": that id means "no view= in the URL", which is the default view's landing.
  { id: "everyone", label: "All open", state: () => ({}) },
  // E3b-2b: my open tasks, the hottest contacts first (their hot-lead score; unscored last).
  {
    id: "hottest",
    label: "Hottest first",
    state: () => ({ ownerId: ["me"], sort: "hotScore:desc" }),
  },
];

/** The "My overdue" count (Overdue tab badge and the sidebar badge). */
export const MY_OVERDUE: TaskListParams = { ownerId: ["me"], due: "overdue" };
export const MY_DUE_TODAY: TaskListParams = { ownerId: ["me"], due: "today" };

export const TASK_VIEW_SPEC: ListViewSpec<TasksSearch> = {
  object: "tasks",
  builtIns: BUILT_IN_VIEWS,
  noFilters: NO_FILTERS,
  multiKeys: MULTI_KEYS,
  toApiParams,
  defaultColumns: DEFAULT_COLUMNS,
  defaultView: "mine",
};
