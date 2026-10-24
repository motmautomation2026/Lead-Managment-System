import { describe, expect, it } from "vitest";
import { companyMatch } from "../../src/domain/companyMatch.js";
import { corporateDomain, FREE_MAIL_DOMAINS, isPlaceholderCompany, normalizeCompanyName } from "../../src/domain/companyNormalize.js";

describe("normalizeCompanyName", () => {
  it("treats Indian legal forms as the same company", () => {
    const forms = ["ABC Engineering Pvt. Ltd.", "ABC Engineering Private Limited", "abc engineering", "  ABC  ENGINEERING (OPC) Pvt Ltd ", "ABC Engineering Ltd", "ABC Engineering LLP"];
    for (const form of forms) expect(normalizeCompanyName(form), form).toBe("abc engineering");
  });

  it.each([
    ["Tata Sons & Co.", "tata sons"],
    ["Tata Sons and Company", "tata sons"],
    ["Johnson & Johnson", "johnson and johnson"],
    ["Acme, Inc.", "acme"],
    ["Acme Corporation", "acme"],
    ["Acme LLC", "acme"],
    ["Infosys", "infosys"],
    ["Café Coffee Day", "café coffee day"],
    ["M/s. Sharma Traders", "m s sharma traders"],
    ["3M India", "3m india"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeCompanyName(input)).toBe(expected);
  });

  it("strips legal words only at the end", () => {
    expect(normalizeCompanyName("Company Logistics Pvt Ltd")).toBe("company logistics");
    expect(normalizeCompanyName("Limited Edition Prints")).toBe("limited edition prints");
  });
});

describe("isPlaceholderCompany", () => {
  it.each(["Not provided", "not provided", "NA", "N/A", "n.a.", "-", "none", "Unknown", "", "   ", "Pvt Ltd", "Private Limited", "Ltd."])("%j is a placeholder", (name) => {
    expect(isPlaceholderCompany(name)).toBe(true);
  });

  it("is false for real names", () => {
    expect(isPlaceholderCompany("ABC Engineering")).toBe(false);
    expect(isPlaceholderCompany("None Such Labs")).toBe(false);
    expect(isPlaceholderCompany(null)).toBe(true);
  });
});

describe("corporateDomain", () => {
  it("returns null for free mail", () => {
    for (const domain of FREE_MAIL_DOMAINS) expect(corporateDomain(`someone@${domain}`), domain).toBeNull();
    expect(corporateDomain("Someone@GMAIL.com")).toBeNull();
  });

  it("returns the lower-case domain for corporate mail", () => {
    expect(corporateDomain(" Ravi@ABC-Engineering.co.in ")).toBe("abc-engineering.co.in");
  });

  it("returns null for missing or invalid email", () => {
    expect(corporateDomain(null)).toBeNull();
    expect(corporateDomain("")).toBeNull();
    expect(corporateDomain("not-an-email")).toBeNull();
  });
});

describe("companyMatch", () => {
  const A = { id: "a", domain: "abc.com" };
  const B = { id: "b", domain: "beta.com" };

  it("placeholder -> none", () => {
    expect(companyMatch({ companyText: "Not provided", email: "x@abc.com", byName: A, byDomain: A })).toEqual({ action: "none", candidates: [] });
    expect(companyMatch({ companyText: "Pvt Ltd", email: null, byName: null, byDomain: null }).action).toBe("none");
  });

  it("nothing found -> create with the corporate domain", () => {
    expect(companyMatch({ companyText: "ABC Engineering Pvt. Ltd.", email: "r@abc.com", byName: null, byDomain: null })).toEqual({
      action: "create",
      normalizedName: "abc engineering",
      domain: "abc.com",
      candidates: [],
    });
  });

  it("free mail -> create without a domain", () => {
    const match = companyMatch({ companyText: "ABC", email: "r@gmail.com", byName: null, byDomain: null });
    expect(match).toMatchObject({ action: "create", domain: null });
  });

  it("same name, same or missing domain -> link, no candidate", () => {
    expect(companyMatch({ companyText: "ABC", email: "r@abc.com", byName: A, byDomain: A })).toMatchObject({ action: "link", companyId: "a", candidates: [] });
    expect(companyMatch({ companyText: "ABC", email: "r@gmail.com", byName: A, byDomain: null })).toMatchObject({ action: "link", companyId: "a", candidates: [] });
    expect(companyMatch({ companyText: "ABC", email: "r@new.com", byName: { id: "a", domain: null }, byDomain: null })).toMatchObject({
      action: "link",
      companyId: "a",
      candidates: [],
    });
  });

  it("same name, domain owned by another company -> link by name + pair candidate", () => {
    expect(companyMatch({ companyText: "ABC", email: "r@beta.com", byName: A, byDomain: B })).toMatchObject({
      action: "link",
      companyId: "a",
      candidates: [{ otherCompanyId: "b", reason: "name_domain_conflict" }],
    });
  });

  it("same name, different domain owned by nobody -> link + contact-level candidate", () => {
    expect(companyMatch({ companyText: "ABC", email: "r@other.com", byName: A, byDomain: null })).toMatchObject({
      action: "link",
      companyId: "a",
      candidates: [{ otherCompanyId: null, reason: "name_domain_conflict" }],
    });
  });

  it("same domain, different name -> link by domain + contact-level candidate", () => {
    expect(companyMatch({ companyText: "TML", email: "r@beta.com", byName: null, byDomain: B })).toMatchObject({
      action: "link",
      companyId: "b",
      normalizedName: "tml",
      candidates: [{ otherCompanyId: null, reason: "same_domain_different_name" }],
    });
  });
});
