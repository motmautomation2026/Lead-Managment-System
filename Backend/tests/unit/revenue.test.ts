import { describe, expect, it } from "vitest";
import { assignmentRulesProblem, describeRule, parseRevenueRange, resolveOwnerByRules, type AssignmentRule } from "../../src/domain/revenue.js";

describe("parseRevenueRange", () => {
  it.each([
    ["₹1–5 Cr", 1, 5],
    ["5-10 Crore", 5, 10],
    ["Above 50 Cr", 50, null],
    ["Below 1 Cr", null, 1],
    ["50L-1Cr", 0.5, 1],
    ["₹ 10 - 25 crores", 10, 25],
    ["Rs. 2.5 Cr", 2.5, 2.5],
    ["Rs 5 to 10 cr", 5, 10],
    ["INR 100 Cr+", 100, null],
    ["50+ Crore", 50, null],
    ["More than 100 crore", 100, null],
    ["Greater than 20 Cr", 20, null],
    ["Less than 50 lakh", null, 0.5],
    ["Up to 5 Cr", null, 5],
    ["upto 75 lakhs", null, 0.75],
    ["Under 1 Cr", null, 1],
    ["10-50 lakh", 0.1, 0.5],
    ["25 L", 0.25, 0.25],
    ["10 lac", 0.1, 0.1],
    ["10", 10, 10],
    ["7.5", 7.5, 7.5],
    ["1 – 5", 1, 5],
    ["₹1,000 Cr", 1000, 1000],
    ["0-1 Cr", 0, 1],
  ])("%s -> %s..%s", (text, minCr, maxCr) => {
    expect(parseRevenueRange(text)).toEqual({ minCr, maxCr });
  });

  it.each([
    [""],
    [null],
    [undefined],
    ["Not disclosed"],
    ["N/A"],
    ["Pre-revenue"],
    ["$5 million"],
    ["5 million"],
    ["10-5 Cr"],
    ["FY 2023-24 revenue 5 cr"],
    ["above 5 up to 10 below 20"],
  ])("%s -> null", (text) => {
    expect(parseRevenueRange(text)).toBeNull();
  });
});

describe("resolveOwnerByRules", () => {
  const rule = (position: number, minCr: number | null, maxCr: number | null, ownerId: string, isActive = true): AssignmentRule => ({ position, minCr, maxCr, ownerId, isActive });
  const rules = [rule(0, null, 5, "A"), rule(1, 5, null, "B")];
  const at = (minCr: number | null, maxCr: number | null) => ({ minCr, maxCr });

  it("puts exactly 5 Cr in 'up to 5' and 5.01 Cr in 'above 5'", () => {
    expect(resolveOwnerByRules(rules, at(5, 5), "F")).toEqual({ ownerId: "A", reason: "Revenue ₹5 Cr matched rule: up to ₹5 Cr" });
    expect(resolveOwnerByRules(rules, at(5.01, 5.01), "F")).toEqual({ ownerId: "B", reason: "Revenue ₹5.01 Cr matched rule: above ₹5 Cr" });
  });

  it("uses maxCr ?? minCr as the lead's value", () => {
    expect(resolveOwnerByRules(rules, at(1, 5), "F")).toMatchObject({ ownerId: "A", reason: "Revenue ₹1–5 Cr matched rule: up to ₹5 Cr" });
    expect(resolveOwnerByRules(rules, at(4, 10), "F").ownerId).toBe("B");
    expect(resolveOwnerByRules(rules, at(null, 1), "F")).toMatchObject({ ownerId: "A", reason: "Revenue up to ₹1 Cr matched rule: up to ₹5 Cr" });
    expect(resolveOwnerByRules(rules, at(50, null), "F")).toMatchObject({ ownerId: "B", reason: "Revenue above ₹50 Cr matched rule: above ₹5 Cr" });
  });

  it("treats an open 'above X' lead as just over X", () => {
    expect(resolveOwnerByRules(rules, at(5, null), "F").ownerId).toBe("B");
    expect(resolveOwnerByRules([rule(0, null, 5, "A")], at(5, null), "F").ownerId).toBe("F");
  });

  it("first match wins in position order, inactive rules are skipped", () => {
    const overlapping = [rule(1, null, null, "Any"), rule(0, 1, 10, "Mid")];
    expect(resolveOwnerByRules(overlapping, at(3, 3), null).ownerId).toBe("Mid");
    expect(resolveOwnerByRules(overlapping, at(30, 30), null).ownerId).toBe("Any");
    expect(resolveOwnerByRules([rule(0, null, null, "Off", false)], at(3, 3), null)).toEqual({ ownerId: null, reason: "No rule matched — unassigned" });
  });

  it("bounded rule: exclusive min, inclusive max", () => {
    const band = [rule(0, 1, 5, "Band")];
    expect(resolveOwnerByRules(band, at(1, 1), "F").ownerId).toBe("F");
    expect(resolveOwnerByRules(band, at(1.01, 1.01), "F")).toMatchObject({ ownerId: "Band", reason: "Revenue ₹1.01 Cr matched rule: above ₹1 Cr up to ₹5 Cr" });
    expect(resolveOwnerByRules(band, at(5, 5), "F").ownerId).toBe("Band");
  });

  it("falls back when revenue is unknown or nothing matches", () => {
    expect(resolveOwnerByRules(rules, null, "F")).toEqual({ ownerId: "F", reason: "Revenue unknown — default owner" });
    expect(resolveOwnerByRules(rules, null, null)).toEqual({ ownerId: null, reason: "Revenue unknown — unassigned" });
    expect(resolveOwnerByRules([], at(3, 3), "F")).toEqual({ ownerId: "F", reason: "No rule matched — default owner" });
  });

  it("describes rules", () => {
    expect(describeRule({ minCr: null, maxCr: null })).toBe("any revenue");
  });
});

describe("assignmentRulesProblem", () => {
  const r = (position: number, minCr: number | null, maxCr: number | null) => ({ position, minCr, maxCr });
  it("accepts a valid list (in any order) and an empty one", () => {
    expect(assignmentRulesProblem([r(1, 5, null), r(0, null, 5)])).toBeNull();
    expect(assignmentRulesProblem([])).toBeNull();
  });
  it.each([
    [[r(0, null, 5), r(2, 5, null)], "Rule positions must run 0, 1, 2… with no gaps or repeats."],
    [[r(0, null, 5), r(0, 5, null)], "Rule positions must run 0, 1, 2… with no gaps or repeats."],
    [[r(1, null, 5)], "Rule positions must run 0, 1, 2… with no gaps or repeats."],
    [[r(0, 5, 5)], 'Rule 1: "From" must be less than "Up to".'],
    [[r(0, null, 5), r(1, 10, 2)], 'Rule 2: "From" must be less than "Up to".'],
    [[r(0, -1, 5)], "Rule 1: revenue must be a positive number of crore."],
    [[r(0, Number.NaN, null)], "Rule 1: revenue must be a positive number of crore."],
  ])("rejects %j", (rules, message) => {
    expect(assignmentRulesProblem(rules)).toBe(message);
  });
  it("caps the number of rules", () => {
    expect(assignmentRulesProblem(Array.from({ length: 51 }, (_, i) => r(i, null, null)))).toBe("At most 50 rules are allowed.");
  });
});
