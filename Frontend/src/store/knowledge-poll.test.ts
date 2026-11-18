import { describe, expect, it } from "vitest";
import { knowledgePollInterval } from "./server-hooks";

describe("knowledge status polling", () => {
  it("polls every 5 s while anything is pending or processing", () => {
    expect(knowledgePollInterval([{ status: "ready" }, { status: "processing" }])).toBe(5000);
    expect(knowledgePollInterval([{ status: "pending" }])).toBe(5000);
  });

  it("stops once everything is ready or failed (or nothing is loaded)", () => {
    expect(
      knowledgePollInterval([{ status: "ready" }, { status: "failed" }, { status: null }]),
    ).toBe(false);
    expect(knowledgePollInterval([])).toBe(false);
    expect(knowledgePollInterval(undefined)).toBe(false);
  });
});
