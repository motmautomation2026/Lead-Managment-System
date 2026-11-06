import { z } from "zod";
import type { FilterValues } from "@/components/crm/filter-model";
import type { SortState } from "@/components/crm/data-table";
import { dateInputValue } from "@/lib/dates";
import type { ContactListParams } from "@/types";
import type { BuiltInView, ListViewSpec } from "@/features/crm/saved-views";

const list = z.array(z.string()).optional();

/**
 * /contacts URL state. Filter keys are the GET /contacts param names, so a URL and a
 * saved view's `filters` are interchangeable (C1-ui.md §1.4).
 */
export const contactsSearchSchema = z.object({
  view: z.string().optional(),
  q: z.string().optional(),
  sort: z.string().optional(),
  columns: list,
  ownerId: list,
  leadStatus: list,
  lifecycle: list,
  source: list,
  agentStatus: list,
  companyId: z.string().optional(),
  hasOpenDeal: z.enum(["true", "false"]).optional(),
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
  lastActivityFrom: z.string().optional(),
  lastActivityTo: z.string().optional(),
});
export type ContactsSearch = z.infer<typeof contactsSearchSchema>;

export const validateContactsSearch = (search: Record<string, unknown>): ContactsSearch => {
  const parsed = contactsSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};

const MULTI_KEYS = ["ownerId", "leadStatus", "lifecycle", "source", "agentStatus"] as const;
const FILTER_KEYS = [
  ...MULTI_KEYS,
  "companyId",
  "hasOpenDeal",
  "createdFrom",
  "createdTo",
  "lastActivityFrom",
  "lastActivityTo",
  "q",
] as const;

/** Every filter key set to undefined: spread first to replace the filters, not merge. */
export const NO_FILTERS = Object.fromEntries(
  [...FILTER_KEYS, "sort", "columns"].map((k) => [k, undefined]),
) as Partial<ContactsSearch>;

export const DEFAULT_SORT = "createdAt:desc";
export const DEFAULT_COLUMNS = [
  "name",
  "hotScore",
  "company",
  "email",
  "phone",
  "owner",
  "leadStatus",
  "openDeal",
  "nextAction",
  "lastActivityAt",
];

/** API params for GET /contacts (+ /count): q only from 2 characters (shorter is a 400). */
export function toApiParams(state: ContactsSearch): ContactListParams {
  const params: ContactListParams = {};
  for (const key of FILTER_KEYS)
    if (state[key] !== undefined) Object.assign(params, { [key]: state[key] });
  const q = state.q?.trim();
  params.q = q && q.length >= 2 ? q : undefined;
  params.sort = state.sort ?? DEFAULT_SORT;
  return params;
}

export function parseSort(sort: string | undefined): SortState {
  const [field, dir] = (sort ?? DEFAULT_SORT).split(":");
  return { field: field ?? "createdAt", dir: dir === "asc" ? "asc" : "desc" };
}

// Whole IST days: the API takes ISO 8601 with an offset, the date pickers YYYY-MM-DD.
export const dayStart = (d: string) => `${d}T00:00:00+05:30`;
export const dayEnd = (d: string) => `${d}T23:59:59+05:30`;
export const day = (iso: string | undefined) => iso?.slice(0, 10);

export function toFilterValues(state: ContactsSearch): FilterValues {
  return {
    ...Object.fromEntries(MULTI_KEYS.map((k) => [k, state[k]])),
    companyId: state.companyId ? [state.companyId] : undefined,
    hasOpenDeal: state.hasOpenDeal === undefined ? undefined : state.hasOpenDeal === "true",
    created:
      state.createdFrom || state.createdTo
        ? { from: day(state.createdFrom), to: day(state.createdTo) }
        : undefined,
    lastActivity:
      state.lastActivityFrom || state.lastActivityTo
        ? { from: day(state.lastActivityFrom), to: day(state.lastActivityTo) }
        : undefined,
  };
}

type Range = { from?: string | undefined; to?: string | undefined } | undefined;

export function fromFilterValues(values: FilterValues): Partial<ContactsSearch> {
  const multi = (k: string) => {
    const v = values[k] as string[] | undefined;
    return v?.length ? v : undefined;
  };
  const created = values["created"] as Range;
  const lastActivity = values["lastActivity"] as Range;
  const company = multi("companyId");
  return {
    ...Object.fromEntries(MULTI_KEYS.map((k) => [k, multi(k)])),
    // The API takes one company; the newest pick wins.
    companyId: company?.[company.length - 1],
    hasOpenDeal:
      typeof values["hasOpenDeal"] === "boolean"
        ? values["hasOpenDeal"]
          ? "true"
          : "false"
        : undefined,
    createdFrom: created?.from ? dayStart(created.from) : undefined,
    createdTo: created?.to ? dayEnd(created.to) : undefined,
    lastActivityFrom: lastActivity?.from ? dayStart(lastActivity.from) : undefined,
    lastActivityTo: lastActivity?.to ? dayEnd(lastActivity.to) : undefined,
  };
}

export const BUILT_IN_VIEWS: BuiltInView<ContactsSearch>[] = [
  { id: "all", label: "All contacts", state: () => ({}) },
  { id: "mine", label: "My contacts", state: () => ({ ownerId: ["me"] }) },
  {
    id: "recent",
    label: "Recently added",
    state: () => ({ createdFrom: dayStart(dateInputValue(-7)) }),
  },
  { id: "unassigned", label: "Unassigned", state: () => ({ ownerId: ["none"] }) },
];

/** Everything the shared saved-views code needs about this list (features/crm/saved-views.ts). */
export const CONTACT_VIEW_SPEC: ListViewSpec<ContactsSearch> = {
  object: "contacts",
  builtIns: BUILT_IN_VIEWS,
  noFilters: NO_FILTERS,
  multiKeys: MULTI_KEYS,
  toApiParams,
  defaultColumns: DEFAULT_COLUMNS,
};
