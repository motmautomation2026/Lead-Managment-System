import { describe, expect, it } from "vitest";
import { fromFilterValues, toApiParams, toFilterValues } from "./contacts-search";

describe("contacts list state", () => {
  it("date filters are whole IST days in the API and YYYY-MM-DD in the pickers", () => {
    const patch = fromFilterValues({ created: { from: "2026-10-01", to: "2026-10-07" } });
    expect(patch).toMatchObject({
      createdFrom: "2026-10-01T00:00:00+05:30",
      createdTo: "2026-10-07T23:59:59+05:30",
    });
    expect(toFilterValues(patch)["created"]).toEqual({ from: "2026-10-01", to: "2026-10-07" });
  });

  it("booleans are the strings true/false; company keeps the newest pick", () => {
    expect(fromFilterValues({ hasOpenDeal: false, companyId: ["a", "b"] })).toMatchObject({
      hasOpenDeal: "false",
      companyId: "b",
    });
    expect(toFilterValues({ hasOpenDeal: "true", companyId: "b" })).toMatchObject({
      hasOpenDeal: true,
      companyId: ["b"],
    });
  });

  it("API params drop view/columns and keep the default sort", () => {
    expect(toApiParams({ view: "mine", columns: ["name"], ownerId: ["me"] })).toEqual({
      ownerId: ["me"],
      sort: "createdAt:desc",
    });
  });
});
