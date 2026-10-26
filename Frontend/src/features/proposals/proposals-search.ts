import { z } from "zod";
import type { FilterValues } from "@/components/crm/filter-model";
import type { SortState } from "@/components/crm/data-table";
import type { PillTone } from "@/components/crm/status-pill";
import { day, dayEnd, dayStart } from "@/features/contacts/contacts-search";
import type { BuiltInView, ListViewSpec } from "@/features/crm/saved-views";
import { PROPOSAL_STATUSES, type ProposalListParams, type ProposalStatus } from "@/types";

const list = z.array(z.string()).optional();

/** /proposals URL state = the GET /proposals/list params. `group` is defined by the backend. */
export const proposalsSearchSchema = z.object({
  view: z.string().optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  columns: list,
  ownerId: list,
  status: z.array(z.enum(PROPOSAL_STATUSES)).optional(),
  group: z.enum(["open", "awaiting_decision", "won", "lost"]).optional(),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  dealId: z.string().optional(),
  updatedFrom: z.string().optional(),
  updatedTo: z.string().optional(),
});
export type ProposalsSearch = z.infer<typeof proposalsSearchSchema>;

export const validateProposalsSearch = (search: Record<string, unknown>): ProposalsSearch => {
  const parsed = proposalsSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};

const MULTI_KEYS = ["ownerId", "status"] as const;
const FILTER_KEYS = [
  ...MULTI_KEYS,
  "group",
  "contactId",
  "companyId",
  "dealId",
  "updatedFrom",
  "updatedTo",
  "q",
] as const;

export const NO_FILTERS = Object.fromEntries(
  [...FILTER_KEYS, "sort", "columns"].map((k) => [k, undefined]),
) as Partial<ProposalsSearch>;

export const DEFAULT_SORT = "updatedAt:desc";
export const DEFAULT_COLUMNS = [
  "title",
  "contact",
  "company",
  "amount",
  "status",
  "sentAt",
  "owner",
  "updatedAt",
  "sendStatus",
];

export function toApiParams(state: ProposalsSearch): ProposalListParams {
  const params: ProposalListParams = {};
  for (const key of FILTER_KEYS)
    if (state[key] !== undefined) Object.assign(params, { [key]: state[key] });
  const q = state.q?.trim();
  params.q = q && q.length >= 2 ? q : undefined;
  params.sort = state.sort ?? DEFAULT_SORT;
  return params;
}

/** The header stats keep the page's filters but not its group/status (they define the stats). */
export function toSummaryParams(state: ProposalsSearch): ProposalListParams {
  const { group: _g, status: _s, sort: _sort, ...filters } = toApiParams(state);
  return filters;
}

export function parseSort(sort: string | undefined): SortState {
  const [field, dir] = (sort ?? DEFAULT_SORT).split(":");
  return { field: field ?? "updatedAt", dir: dir === "asc" ? "asc" : "desc" };
}

export function toFilterValues(state: ProposalsSearch): FilterValues {
  return {
    ownerId: state.ownerId,
    status: state.status,
    updated:
      state.updatedFrom || state.updatedTo
        ? { from: day(state.updatedFrom), to: day(state.updatedTo) }
        : undefined,
  };
}

type Range = { from?: string | undefined; to?: string | undefined } | undefined;

export function fromFilterValues(values: FilterValues): Partial<ProposalsSearch> {
  const multi = <T extends string>(k: string) => {
    const v = values[k] as T[] | undefined;
    return v?.length ? v : undefined;
  };
  const range = values["updated"] as Range;
  return {
    ownerId: multi("ownerId"),
    status: multi<ProposalStatus>("status"),
    updatedFrom: range?.from ? dayStart(range.from) : undefined,
    updatedTo: range?.to ? dayEnd(range.to) : undefined,
  };
}

export const BUILT_IN_VIEWS: BuiltInView<ProposalsSearch>[] = [
  { id: "open", label: "Open", state: () => ({ group: "open" }) },
  { id: "awaiting", label: "Awaiting decision", state: () => ({ group: "awaiting_decision" }) },
  { id: "won", label: "Won", state: () => ({ group: "won" }) },
  { id: "lost", label: "Lost", state: () => ({ group: "lost" }) },
  // Not "all": with a default view, that id would clear the URL and land on Open again.
  { id: "everyone", label: "All", state: () => ({}) },
];

export const PROPOSAL_VIEW_SPEC: ListViewSpec<ProposalsSearch> = {
  object: "proposals",
  builtIns: BUILT_IN_VIEWS,
  noFilters: NO_FILTERS,
  multiKeys: MULTI_KEYS,
  toApiParams,
  defaultColumns: DEFAULT_COLUMNS,
  defaultView: "open",
};

/** Display tones only; which moves are allowed comes from each row's allowedNextStatuses. */
export const PROPOSAL_STATUS_TONE: Record<ProposalStatus, PillTone> = {
  draft: "neutral",
  uploaded: "neutral",
  ready_to_send: "neutral",
  sent: "info",
  revision_requested: "warning",
  revised: "info",
  accepted: "success",
  rejected: "danger",
  withdrawn: "neutral",
  expired: "warning",
};
