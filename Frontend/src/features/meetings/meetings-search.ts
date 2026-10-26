import { z } from "zod";
import type { FilterValues } from "@/components/crm/filter-model";
import type { SortState } from "@/components/crm/data-table";
import { day, dayEnd, dayStart } from "@/features/contacts/contacts-search";
import type { BuiltInView, ListViewSpec } from "@/features/crm/saved-views";
import { MEETING_STATUSES, type MeetingListParams } from "@/types";

const list = z.array(z.string()).optional();

/**
 * /meetings URL state = the GET /meetings/list params. `when` (upcoming / today / past /
 * needs_outcome) is decided by the backend in IST; the page only passes it.
 */
export const meetingsSearchSchema = z.object({
  view: z.string().optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  columns: list,
  ownerId: list,
  status: z.array(z.enum(MEETING_STATUSES)).optional(),
  when: z.enum(["upcoming", "today", "past", "needs_outcome"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  dealId: z.string().optional(),
});
export type MeetingsSearch = z.infer<typeof meetingsSearchSchema>;

export const validateMeetingsSearch = (search: Record<string, unknown>): MeetingsSearch => {
  const parsed = meetingsSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};

const MULTI_KEYS = ["ownerId", "status"] as const;
const FILTER_KEYS = [
  ...MULTI_KEYS,
  "when",
  "from",
  "to",
  "contactId",
  "companyId",
  "dealId",
  "q",
] as const;

export const NO_FILTERS = Object.fromEntries(
  [...FILTER_KEYS, "sort", "columns"].map((k) => [k, undefined]),
) as Partial<MeetingsSearch>;

export const DEFAULT_SORT = "at:asc";
export const DEFAULT_COLUMNS = [
  "title",
  "at",
  "contact",
  "company",
  "owner",
  "status",
  "outcome",
  "calendar",
  "notify",
  "link",
];

export function toApiParams(state: MeetingsSearch): MeetingListParams {
  const params: MeetingListParams = {};
  for (const key of FILTER_KEYS)
    if (state[key] !== undefined) Object.assign(params, { [key]: state[key] });
  const q = state.q?.trim();
  params.q = q && q.length >= 2 ? q : undefined;
  params.sort = state.sort ?? DEFAULT_SORT;
  return params;
}

export function parseSort(sort: string | undefined): SortState {
  const [field, dir] = (sort ?? DEFAULT_SORT).split(":");
  return { field: field ?? "at", dir: dir === "desc" ? "desc" : "asc" };
}

export function toFilterValues(state: MeetingsSearch): FilterValues {
  return {
    ownerId: state.ownerId,
    status: state.status,
    dateRange: state.from || state.to ? { from: day(state.from), to: day(state.to) } : undefined,
  };
}

type Range = { from?: string | undefined; to?: string | undefined } | undefined;

export function fromFilterValues(values: FilterValues): Partial<MeetingsSearch> {
  const multi = <T extends string>(k: string) => {
    const v = values[k] as T[] | undefined;
    return v?.length ? v : undefined;
  };
  const range = values["dateRange"] as Range;
  return {
    ownerId: multi("ownerId"),
    status: multi<(typeof MEETING_STATUSES)[number]>("status"),
    from: range?.from ? dayStart(range.from) : undefined,
    to: range?.to ? dayEnd(range.to) : undefined,
  };
}

export const BUILT_IN_VIEWS: BuiltInView<MeetingsSearch>[] = [
  { id: "upcoming", label: "Upcoming", state: () => ({ when: "upcoming" }) },
  { id: "today", label: "Today", state: () => ({ when: "today" }) },
  {
    id: "needs_outcome",
    label: "Needs outcome",
    state: () => ({ when: "needs_outcome", sort: "at:desc" }),
  },
  {
    id: "completed",
    label: "Completed",
    state: () => ({ status: ["completed"], sort: "at:desc" }),
  },
  {
    id: "cancelled",
    label: "Cancelled",
    state: () => ({ status: ["cancelled"], sort: "at:desc" }),
  },
  // Not "all": with a default view, that id would clear the URL and land on Upcoming again.
  { id: "everyone", label: "All", state: () => ({ sort: "at:desc" }) },
];

export const NEEDS_OUTCOME: MeetingListParams = { when: "needs_outcome" };

export const MEETING_VIEW_SPEC: ListViewSpec<MeetingsSearch> = {
  object: "meetings",
  builtIns: BUILT_IN_VIEWS,
  noFilters: NO_FILTERS,
  multiKeys: MULTI_KEYS,
  toApiParams,
  defaultColumns: DEFAULT_COLUMNS,
  defaultView: "upcoming",
};
