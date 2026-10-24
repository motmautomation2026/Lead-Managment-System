import { describe, expect, it } from "vitest";
import { crumbsFor, isNavActive } from "@/app/nav";

describe("crumbsFor", () => {
  it("names the nav section", () => {
    expect(crumbsFor("/")).toEqual([{ label: "Dashboard" }]);
    expect(crumbsFor("/leads")).toEqual([{ label: "Contacts" }]);
    expect(crumbsFor("/automations/")).toEqual([{ label: "Workflows" }]);
    expect(crumbsFor("/companies")).toEqual([{ label: "Companies" }]);
  });

  it("adds a linked parent for sub-pages", () => {
    expect(crumbsFor("/leads/abc")).toEqual([
      { label: "Contacts", to: "/leads" },
      { label: "Contact" },
    ]);
    expect(crumbsFor("/automations/runs")).toEqual([
      { label: "Workflows", to: "/automations" },
      { label: "Runs" },
    ]);
  });

  it("returns nothing for unknown paths", () => {
    expect(crumbsFor("/nope")).toEqual([]);
  });
});

describe("isNavActive", () => {
  it("matches the section and its children, not lookalike prefixes", () => {
    expect(isNavActive("/", "/")).toBe(true);
    expect(isNavActive("/", "/leads")).toBe(false);
    expect(isNavActive("/leads", "/leads/1")).toBe(true);
    expect(isNavActive("/leads", "/leadsx")).toBe(false);
  });
});
