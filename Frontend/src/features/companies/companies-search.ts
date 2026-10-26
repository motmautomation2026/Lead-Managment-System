import { z } from "zod";
import type { FilterValues } from "@/components/crm/filter-model";
import type { SortState } from "@/components/crm/data-table";
import { dateInputValue } from "@/lib/dates";
import { day, dayEnd, dayStart } from "@/features/contacts/contacts-search";
import type { CompanyListParams, SavedView } from "@/types";

const list = z.array(z.string()).optional();

/**
 * /companies URL state. Filter keys are the GET /companies param names, so a URL and a
 * saved view's `filters` are interchangeable (C1-ui.md §1.4). Same shape as Contacts.
 */
export const companiesSearchSchema = z.object({
  view: z.string().optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  columns: list,
  ownerId: list,
  industry: list,
  hasDomain: z.enum(["true", "false"]).optional(),
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
});
export type CompaniesSearch = z.infer<typeof companiesSearchSchema>;

export const validateCompaniesSearch = (search: Record<string, unknown>): CompaniesSearch => {
  const parsed = companiesSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};

const MULTI_KEYS = ["ownerId", "industry"] as const;
const FILTER_KEYS = [...MULTI_KEYS, "hasDomain", "createdFrom", "createdTo", "q"] as const;

/** Every filter key set to undefined: spread first to replace the filters, not merge. */
export const NO_FILTERS = Object.fromEntries(
  [...FILTER_KEYS, "sort", "columns"].map((k) => [k, undefined]),
) as Partial<CompaniesSearch>;

export const DEFAULT_SORT = "name:asc";
export const DEFAULT_COLUMNS = [
  "name",
  "domain",
  "industry",
  "city",
  "owner",
  "contactCount",
  "openDealCount",
  "updatedAt",
];

/** API params for GET /companies (+ /count): q only from 2 characters (shorter is a 400). */
export function toApiParams(state: CompaniesSearch): CompanyListParams {
  const params: CompanyListParams = {};
  for (const key of FILTER_KEYS)
    if (state[key] !== undefined) Object.assign(params, { [key]: state[key] });
  const q = state.q?.trim();
  params.q = q && q.length >= 2 ? q : undefined;
  params.sort = state.sort ?? DEFAULT_SORT;
  return params;
}

export function parseSort(sort: string | undefined): SortState {
  const [field, dir] = (sort ?? DEFAULT_SORT).split(":");
  return { field: field ?? "name", dir: dir === "desc" ? "desc" : "asc" };
}

export function toFilterValues(state: CompaniesSearch): FilterValues {
  return {
    ownerId: state.ownerId,
    industry: state.industry,
    hasDomain: state.hasDomain === undefined ? undefined : state.hasDomain === "true",
    created:
      state.createdFrom || state.createdTo
        ? { from: day(state.createdFrom), to: day(state.createdTo) }
        : undefined,
  };
}

type Range = { from?: string | undefined; to?: string | undefined } | undefined;

export function fromFilterValues(values: FilterValues): Partial<CompaniesSearch> {
  const multi = (k: string) => {
    const v = values[k] as string[] | undefined;
    return v?.length ? v : undefined;
  };
  const created = values["created"] as Range;
  const hasDomain = values["hasDomain"];
  return {
    ownerId: multi("ownerId"),
    industry: multi("industry"),
    hasDomain: typeof hasDomain === "boolean" ? (hasDomain ? "true" : "false") : undefined,
    createdFrom: created?.from ? dayStart(created.from) : undefined,
    createdTo: created?.to ? dayEnd(created.to) : undefined,
  };
}

export interface CompanyView {
  id: string;
  label: string;
  /** URL patch applied after NO_FILTERS. */
  state: () => Partial<CompaniesSearch>;
  saved?: SavedView;
}

export const BUILT_IN_VIEWS: CompanyView[] = [
  { id: "all", label: "All companies", state: () => ({}) },
  { id: "mine", label: "My companies", state: () => ({ ownerId: ["me"] }) },
  {
    id: "recent",
    label: "Recently added",
    state: () => ({ createdFrom: dayStart(dateInputValue(-7)) }),
  },
];

/** A saved view's stored params → URL state (multi params may come back as one string). */
export function savedViewState(view: SavedView): Partial<CompaniesSearch> {
  const state: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(view.filters)) {
    state[key] =
      (MULTI_KEYS as readonly string[]).includes(key) && !Array.isArray(value) ? [value] : value;
  }
  return {
    ...(state as Partial<CompaniesSearch>),
    sort: view.sort ?? undefined,
    columns: view.columns ?? undefined,
  };
}

/** The current list as a saved view body (filters exactly as the API params). */
export function toSavedViewBody(state: CompaniesSearch) {
  const { sort: _sort, ...filters } = toApiParams(state);
  return {
    filters: Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v !== undefined),
    ) as Record<string, string | string[]>,
    sort: state.sort ?? null,
    columns: state.columns ?? null,
  };
}
