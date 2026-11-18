import { describe, expect, it } from "vitest";
import { crumbsFor, isNavActive } from "@/app/nav";

describe("crumbsFor", () => {
  it("names the nav section", () => {
    expect(crumbsFor("/")).toEqual([{ label: "Home" }]);
    expect(crumbsFor("/contacts")).toEqual([{ label: "Contacts" }]);
    expect(crumbsFor("/automations/")).toEqual([{ label: "Workflows" }]);
    expect(crumbsFor("/companies")).toEqual([{ label: "Companies" }]);
    expect(crumbsFor("/search")).toEqual([{ label: "Search" }]);
  });

  it("adds a linked parent for sub-pages", () => {
    expect(crumbsFor("/contacts/abc")).toEqual([
      { label: "Contacts", to: "/contacts" },
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
    expect(isNavActive("/", "/contacts")).toBe(false);
    expect(isNavActive("/contacts", "/contacts/1")).toBe(true);
    expect(isNavActive("/contacts", "/contactsx")).toBe(false);
  });
});
