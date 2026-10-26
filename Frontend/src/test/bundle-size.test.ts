import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs script without type declarations
import { BUDGET_KB, checkBudget } from "../../scripts/check-bundle-size.mjs";

describe("first-load budget guard (scripts/check-bundle-size.mjs)", () => {
  it("passes at or under the budget", () => {
    expect(checkBudget(BUDGET_KB)).toEqual({ ok: true, message: null });
    expect(checkBudget(290).ok).toBe(true);
  });
  it("fails above the budget with how much it is over", () => {
    const verdict = checkBudget(BUDGET_KB + 12.34);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("over budget by 12.3 kB");
  });
});
