import type { AssignmentRuleInput } from "@/lib/backend-client";

/** One editable rule row; the bounds stay as typed until saved. */
export interface RuleRow {
  from: string;
  to: string;
  ownerId: string;
}

const bound = (text: string) => (text.trim() === "" ? null : Number(text));

/** The first problem with the rows, or null when they can be saved (the backend re-validates). */
export function ruleRowsProblem(rows: RuleRow[]): string | null {
  for (const [index, row] of rows.entries()) {
    const label = `Rule ${index + 1}`;
    if (!row.ownerId) return `${label}: choose an owner.`;
    const from = bound(row.from);
    const to = bound(row.to);
    for (const value of [from, to]) {
      if (value !== null && !(Number.isFinite(value) && value >= 0))
        return `${label}: enter revenue as a positive number of crore.`;
    }
    if (from !== null && to !== null && from >= to)
      return `${label}: "From" must be less than "Up to".`;
  }
  return null;
}

export function rowsToRules(rows: RuleRow[]): AssignmentRuleInput[] {
  return rows.map((row, position) => ({
    position,
    minCr: bound(row.from),
    maxCr: bound(row.to),
    ownerId: row.ownerId,
  }));
}

/**
 * Preview only, mirroring the backend's resolveOwnerByRules for one exact
 * value: first rule with value > from (if set) and value <= to (if set).
 */
export function previewOwner(rows: RuleRow[], value: number): string | null | undefined {
  const match = rows.find((row) => {
    const from = bound(row.from);
    const to = bound(row.to);
    return (from === null || value > from) && (to === null || value <= to);
  });
  return match?.ownerId;
}
