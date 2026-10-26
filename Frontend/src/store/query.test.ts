import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { BackendError } from "@/lib/backend-client";
import { keys, messageFromError, refreshCompany, refreshContact, refreshDeal } from "./query";

describe("query invalidation", () => {
  it("refreshes every contact-dependent aggregate after a composite mutation", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();

    await refreshContact(client, "workspace-1", "lead-1");

    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(invalidated).toEqual(
      expect.arrayContaining([
        keys.lead("workspace-1", "lead-1"),
        keys.notes("workspace-1", "lead-1"),
        keys.contactability("workspace-1", "lead-1"),
        keys.work("workspace-1"),
        keys.runs("workspace-1"),
        keys.scheduledActions("workspace-1"),
        keys.notifications("workspace-1"),
        keys.home("workspace-1"),
        keys.contact("workspace-1", "lead-1"),
        keys.contacts("workspace-1"),
        keys.contactsCount("workspace-1"),
        keys.deals("workspace-1"),
        keys.agentLeadPanel("workspace-1", "lead-1"),
        keys.contactTimeline("workspace-1", "lead-1"),
        keys.companies("workspace-1"),
        ["company", "workspace-1"],
        ["companyTimeline", "workspace-1"],
        ["companyContacts", "workspace-1"],
      ]),
    );
  });

  it("refreshCompany refreshes company views, duplicates, search and every contact", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    await refreshCompany(client, "workspace-1");
    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(invalidated).toEqual(
      expect.arrayContaining([
        keys.companies("workspace-1"),
        keys.companiesCount("workspace-1"),
        ["company", "workspace-1"],
        ["companyDeals", "workspace-1"],
        keys.companyDuplicates("workspace-1"),
        keys.companyDuplicatesCount("workspace-1"),
        ["companySearch", "workspace-1"],
        ["contact", "workspace-1"],
        keys.contacts("workspace-1"),
      ]),
    );
  });

  it("refreshDeal refreshes every deal query (one prefix), contacts, companies and search", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    await refreshDeal(client, "workspace-1");
    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(invalidated).toEqual(
      expect.arrayContaining([
        keys.deals("workspace-1"),
        ["contact", "workspace-1"],
        ["contactTimeline", "workspace-1"],
        keys.contacts("workspace-1"),
        ["company", "workspace-1"],
        ["companyDeals", "workspace-1"],
        ["companyTimeline", "workspace-1"],
        ["search", "workspace-1"],
      ]),
    );
    // Every deal key lives under the one prefix that refreshDeal invalidates.
    for (const key of [
      keys.dealList("workspace-1", {}),
      keys.dealCount("workspace-1", {}),
      keys.dealBoard("workspace-1", {}),
      keys.deal("workspace-1", "d1"),
      keys.dealTimeline("workspace-1", "d1", {}),
    ])
      expect(key.slice(0, 2)).toEqual(keys.deals("workspace-1"));
  });

  it("without a lead id refreshes every contact's record queries (bulk actions)", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    await refreshContact(client, "workspace-1");
    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(invalidated).toEqual(
      expect.arrayContaining([
        ["contact", "workspace-1"],
        ["lead", "workspace-1"],
        ["contactTimeline", "workspace-1"],
        keys.contacts("workspace-1"),
        keys.agentLeadPanel("workspace-1"),
      ]),
    );
  });

  it("keys every workspace-scoped query by the workspace id so switching workspaces changes the cache key", () => {
    expect(keys.contacts("workspace-1")).not.toEqual(keys.contacts("workspace-2"));
    expect(keys.contacts(null)).toEqual(["contacts", null]);
  });
});

describe("messageFromError", () => {
  it("shows the backend message as-is", () => {
    const error = new BackendError(
      400,
      "invalid_input",
      "Choose an objection type before moving a lead to Objection Nurture.",
      { constraint: "leads_objection_stage_has_type" },
    );
    expect(messageFromError(error)).toBe(
      "Choose an objection type before moving a lead to Objection Nurture.",
    );
  });

  it("lists field names and problems from a 400 validation error", () => {
    const error = new BackendError(400, "invalid_input", "Some fields are missing or invalid.", {
      formErrors: [],
      fieldErrors: { firstName: ["Required"], senderAddress: ["Invalid email"], phone: [] },
    });
    expect(messageFromError(error)).toBe(
      "Some fields are missing or invalid. First name: Required; Sender address: Invalid email",
    );
  });

  it("includes form-level errors", () => {
    const error = new BackendError(400, "invalid_input", "Some fields are missing or invalid.", {
      formErrors: ["Unrecognized key: extra"],
      fieldErrors: {},
    });
    expect(messageFromError(error)).toBe(
      "Some fields are missing or invalid. Unrecognized key: extra",
    );
  });

  it("adds the reference of an unexpected error", () => {
    const error = new BackendError(500, "internal_error", "connect ECONNREFUSED", {
      requestId: "req-123",
    });
    expect(messageFromError(error)).toBe("connect ECONNREFUSED Reference: req-123");
  });

  it("does not repeat a reference the message already quotes", () => {
    const error = new BackendError(
      500,
      "internal_error",
      "Something went wrong. Reference: req-123",
      { requestId: "req-123" },
    );
    expect(messageFromError(error)).toBe("Something went wrong. Reference: req-123");
  });

  it("handles plain errors and non-errors", () => {
    expect(messageFromError(new Error("Network down"))).toBe("Network down");
    expect(messageFromError("nope")).toBe("The request failed.");
    expect(messageFromError(new BackendError(404, "not_found", "", undefined))).toBe(
      "The request failed.",
    );
  });
});
