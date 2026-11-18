import { describe, expect, it } from "vitest";
import { companyDescription, companyFacts, resolveCompany, type CompanyRecord } from "../../src/agent/companyFacts.js";
import { buildDealContext, hasDealContext, type AgentDealRow } from "../../src/agent/dealContext.js";

const company = (overrides: Partial<CompanyRecord> = {}): CompanyRecord => ({
  id: "co-1",
  name: "Acme Steel Pvt Ltd",
  domain: "acmesteel.in",
  website: "https://acmesteel.in",
  industry: "Steel manufacturing",
  revenueRange: "50-100 Cr",
  city: "Pune",
  state: "Maharashtra",
  country: "India",
  employeeRange: "201-500",
  description: "Family-owned mill.",
  mergedIntoCompanyId: null,
  ...overrides,
});
const contact = { industry: "Steel", revenueRange: "10-50 Cr" };

describe("companyFacts", () => {
  it("company first", () => {
    expect(companyFacts(company(), contact)).toEqual({
      id: "co-1",
      name: "Acme Steel Pvt Ltd",
      domain: "acmesteel.in",
      website: "https://acmesteel.in",
      industry: "Steel manufacturing",
      revenueRange: "50-100 Cr",
      location: "Pune, Maharashtra, India",
      employeeRange: "201-500",
    });
  });

  it("falls back to the contact per field (industry, revenue) when the company's is empty", () => {
    expect(companyFacts(company({ industry: null }), contact)).toMatchObject({ industry: "Steel", revenueRange: "50-100 Cr" });
    expect(companyFacts(company({ revenueRange: "  " }), contact)).toMatchObject({ industry: "Steel manufacturing", revenueRange: "10-50 Cr" });
    expect(companyFacts(company({ industry: "", revenueRange: null }), { industry: null, revenueRange: null })).toMatchObject({ industry: null, revenueRange: null });
  });

  it("joins only the known location parts", () => {
    expect(companyFacts(company({ city: null, state: "" }), contact)!.location).toBe("India");
    expect(companyFacts(company({ city: null, state: null, country: null }), contact)!.location).toBeNull();
  });

  it("no company → null", () => {
    expect(companyFacts(null, contact)).toBeNull();
  });

  it("caps the description at 500 characters", () => {
    expect(companyDescription(company({ description: "x".repeat(800) }))).toHaveLength(500);
    expect(companyDescription(company({ description: "  " }))).toBeNull();
    expect(companyDescription(null)).toBeNull();
  });
});

describe("resolveCompany", () => {
  it("follows a merged company once", () => {
    const target = company({ id: "co-2", name: "Acme Group" });
    expect(resolveCompany(company({ mergedIntoCompanyId: "co-2" }), target)).toBe(target);
  });

  it("a target that is itself merged, or missing → no company", () => {
    expect(resolveCompany(company({ mergedIntoCompanyId: "co-2" }), company({ id: "co-2", mergedIntoCompanyId: "co-3" }))).toBeNull();
    expect(resolveCompany(company({ mergedIntoCompanyId: "co-2" }), null)).toBeNull();
  });

  it("an unmerged company is used as is; none → null", () => {
    const linked = company();
    expect(resolveCompany(linked, null)).toBe(linked);
    expect(resolveCompany(null, null)).toBeNull();
  });
});

describe("buildDealContext", () => {
  const NOW = new Date("2026-10-27T11:00:00Z");
  const deal = (overrides: Partial<AgentDealRow>): AgentDealRow => ({
    id: "d-1",
    name: "Acme – outbound",
    stage: "proposal_sent",
    updatedAt: new Date("2026-10-20T00:00:00Z"),
    stageSince: new Date("2026-10-17T10:00:00Z"),
    expectedCloseDate: "2026-12-15",
    latestMeeting: null,
    latestProposal: { status: "sent" },
    ...overrides,
  });

  it("picks the most recently updated open deal and counts won / lost", () => {
    const ctx = buildDealContext(
      [
        deal({ id: "d-old", updatedAt: new Date("2026-10-01T00:00:00Z") }),
        deal({ id: "d-new", name: "Acme – renewal", stage: "negotiation", updatedAt: new Date("2026-10-25T00:00:00Z") }),
        deal({ id: "d-won", stage: "won", updatedAt: new Date("2026-10-26T00:00:00Z") }),
        deal({ id: "d-lost", stage: "lost", updatedAt: new Date("2026-10-26T00:00:00Z") }),
        deal({ id: "d-lost2", stage: "lost" }),
      ],
      NOW,
    );
    expect(ctx).toEqual({
      open: {
        id: "d-new",
        name: "Acme – renewal",
        stage: "negotiation",
        stageLabel: "Negotiation",
        daysInStage: 10,
        expectedCloseMonth: "December 2026",
        latestMeeting: null,
        latestProposal: { status: "sent" },
      },
      wonCount: 1,
      lostCount: 2,
    });
  });

  it("ties on updated_at → the higher id (as /contacts: updated_at desc, id desc)", () => {
    expect(buildDealContext([deal({ id: "a" }), deal({ id: "b" })], NOW).open!.id).toBe("b");
  });

  it("no deals / only closed deals", () => {
    expect(buildDealContext([], NOW)).toEqual({ open: null, wonCount: 0, lostCount: 0 });
    expect(hasDealContext(buildDealContext([], NOW))).toBe(false);
    const closed = buildDealContext([deal({ stage: "won" })], NOW);
    expect(closed.open).toBeNull();
    expect(hasDealContext(closed)).toBe(true);
  });

  it("no expected close date → null month", () => {
    expect(buildDealContext([deal({ expectedCloseDate: null })], NOW).open!.expectedCloseMonth).toBeNull();
  });
});
