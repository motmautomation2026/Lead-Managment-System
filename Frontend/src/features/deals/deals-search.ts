import { z } from "zod";
import type { FilterValues, NumberRange } from "@/components/crm/filter-model";
import type { SortState } from "@/components/crm/data-table";
import { dateInputValue } from "@/lib/dates";
import { day, dayEnd, dayStart } from "@/features/contacts/contacts-search";
import { DEAL_STAGES, type DealListParams } from "@/types";
import type { BuiltInView, ListViewSpec } from "@/features/crm/saved-views";

const list = z.array(z.string()).optional();

/**
 * /deals URL state. Filter keys are the GET /deals param names, so a URL and a saved view's
 * `filters` are interchangeable (C1-ui.md §1.4). `layout` and `showClosed` are page state only.
 */
export const dealsSearchSchema = z.object({
  view: z.string().optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  columns: list,
  layout: z.enum(["table", "board"]).optional(),
  /** Board only: fill the Won/Lost columns (status=all). */
  showClosed: z.enum(["true"]).optional(),
  stage: z.array(z.enum(DEAL_STAGES)).optional(),
  ownerId: list,
  status: z.enum(["open", "won", "lost", "all"]).optional(),
  companyId: z.string().optional(),
  amountMin: z.string().optional(),
  amountMax: z.string().optional(),
  expectedCloseFrom: z.string().optional(),
  expectedCloseTo: z.string().optional(),
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
});
export type DealsSearch = z.infer<typeof dealsSearchSchema>;

export const validateDealsSearch = (search: Record<string, unknown>): DealsSearch => {
  const parsed = dealsSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};

const MULTI_KEYS = ["stage", "ownerId"] as const;
const FILTER_KEYS = [
  ...MULTI_KEYS,
  "status",
  "companyId",
  "amountMin",
  "amountMax",
  "expectedCloseFrom",
  "expectedCloseTo",
  "createdFrom",
  "createdTo",
  "q",
] as const;

/** Every filter key set to undefined: spread first to replace the filters, not merge. */
export const NO_FILTERS = Object.fromEntries(
  [...FILTER_KEYS, "sort", "columns"].map((k) => [k, undefined]),
) as Partial<DealsSearch>;

export const DEFAULT_SORT = "updatedAt:desc";
export const DEFAULT_COLUMNS = [
  "name",
  "stage",
  "amount",
  "expectedCloseDate",
  "owner",
  "company",
  "contact",
  "updatedAt",
];

/** API params for GET /deals (+ /count): q only from 2 characters (shorter is a 400). */
export function toApiParams(state: DealsSearch): DealListParams {
  const params: DealListParams = {};
  for (const key of FILTER_KEYS)
    if (state[key] !== undefined) Object.assign(params, { [key]: state[key] });
  const q = state.q?.trim();
  params.q = q && q.length >= 2 ? q : undefined;
  params.sort = state.sort ?? DEFAULT_SORT;
  return params;
}

/**
 * The board's filters: the table's, minus `stage` and `sort` (columns are the stages, cards are
 * newest first), with `status` from the Show closed toggle (open, or all to fill Won/Lost).
 */
export function toBoardParams(state: DealsSearch): DealListParams {
  const { stage: _stage, sort: _sort, ...filters } = toApiParams(state);
  return { ...filters, status: state.showClosed ? "all" : "open" };
}

export function parseSort(sort: string | undefined): SortState {
  const [field, dir] = (sort ?? DEFAULT_SORT).split(":");
  return { field: field ?? "updatedAt", dir: dir === "asc" ? "asc" : "desc" };
}

const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));

export function toFilterValues(state: DealsSearch): FilterValues {
  return {
    stage: state.stage,
    ownerId: state.ownerId,
    status: state.status ? [state.status] : undefined,
    amount:
      state.amountMin || state.amountMax
        ? { min: num(state.amountMin), max: num(state.amountMax) }
        : undefined,
    expectedClose:
      state.expectedCloseFrom || state.expectedCloseTo
        ? { from: state.expectedCloseFrom, to: state.expectedCloseTo }
        : undefined,
    created:
      state.createdFrom || state.createdTo
        ? { from: day(state.createdFrom), to: day(state.createdTo) }
        : undefined,
  };
}

type Range = { from?: string | undefined; to?: string | undefined } | undefined;

export function fromFilterValues(values: FilterValues): Partial<DealsSearch> {
  const multi = <T extends string>(k: string) => {
    const v = values[k] as T[] | undefined;
    return v?.length ? v : undefined;
  };
  const amount = values["amount"] as NumberRange | undefined;
  const close = values["expectedClose"] as Range;
  const created = values["created"] as Range;
  // Status is single-valued in the API: the last picked option wins.
  const status = multi<NonNullable<DealsSearch["status"]>>("status");
  return {
    stage: multi<(typeof DEAL_STAGES)[number]>("stage"),
    ownerId: multi("ownerId"),
    status: status?.[status.length - 1],
    amountMin: amount?.min !== undefined ? String(amount.min) : undefined,
    amountMax: amount?.max !== undefined ? String(amount.max) : undefined,
    expectedCloseFrom: close?.from || undefined,
    expectedCloseTo: close?.to || undefined,
    createdFrom: created?.from ? dayStart(created.from) : undefined,
    createdTo: created?.to ? dayEnd(created.to) : undefined,
  };
}

/** First and last day (YYYY-MM-DD) of the current month in IST. */
export function currentIstMonth(): { from: string; to: string } {
  const today = dateInputValue(0);
  const [y, m] = today.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ym = today.slice(0, 7);
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
}

export const BUILT_IN_VIEWS: BuiltInView<DealsSearch>[] = [
  { id: "all", label: "All open deals", state: () => ({}) },
  { id: "mine", label: "My deals", state: () => ({ ownerId: ["me"] }) },
  {
    id: "closing",
    label: "Closing this month",
    state: () => {
      const month = currentIstMonth();
      return { expectedCloseFrom: month.from, expectedCloseTo: month.to };
    },
  },
  { id: "won", label: "Won", state: () => ({ status: "won" }) },
  { id: "lost", label: "Lost", state: () => ({ status: "lost" }) },
];

/** Everything the shared saved-views code needs about this list (features/crm/saved-views.ts). */
export const DEAL_VIEW_SPEC: ListViewSpec<DealsSearch> = {
  object: "deals",
  builtIns: BUILT_IN_VIEWS,
  noFilters: NO_FILTERS,
  multiKeys: MULTI_KEYS,
  toApiParams,
  defaultColumns: DEFAULT_COLUMNS,
};
