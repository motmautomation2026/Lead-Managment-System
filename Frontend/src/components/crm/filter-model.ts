/** Filter definitions and values shared by FilterBar and the list pages. */
export type FilterDef = { id: string; label: string } & (
  | { type: "multi"; options: Array<{ value: string; label: string }> }
  | { type: "dateRange" }
  | { type: "numberRange" }
  | { type: "boolean"; trueLabel?: string; falseLabel?: string }
);

export type DateRange = { from?: string | undefined; to?: string | undefined };
export type NumberRange = { min?: number | undefined; max?: number | undefined };
export type FilterValue = string[] | DateRange | NumberRange | boolean;
export type FilterValues = Record<string, FilterValue | undefined>;

export function isFilterActive(value: FilterValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  return Object.values(value).some((v) => v !== undefined && v !== "");
}

export function activeFilterCount(values: FilterValues) {
  return Object.values(values).filter(isFilterActive).length;
}

/** Short chip text for an active filter ("Owner: Asha +1", "Amount: ≥ 50000"). */
export function filterSummary(def: FilterDef, value: FilterValue | undefined): string | null {
  if (!isFilterActive(value)) return null;
  switch (def.type) {
    case "multi": {
      const picked = value as string[];
      const first = def.options.find((o) => o.value === picked[0])?.label ?? picked[0];
      return picked.length > 1 ? `${first} +${picked.length - 1}` : (first ?? null);
    }
    case "boolean":
      return value ? (def.trueLabel ?? "Yes") : (def.falseLabel ?? "No");
    case "dateRange": {
      const { from, to } = value as DateRange;
      return from && to ? `${from} – ${to}` : from ? `from ${from}` : `until ${to}`;
    }
    case "numberRange": {
      const { min, max } = value as NumberRange;
      return min !== undefined && max !== undefined
        ? `${min} – ${max}`
        : min !== undefined
          ? `≥ ${min}`
          : `≤ ${max}`;
    }
  }
}
