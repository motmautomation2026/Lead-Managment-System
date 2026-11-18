import { describe, expect, it } from "vitest";
import { companyMatch } from "../../src/domain/companyMatch.js";
import { corporateDomain, FREE_MAIL_DOMAINS, isPlaceholderCompany, isReservedDomain, normalizeCompanyName, normalizeDomain } from "../../src/domain/companyNormalize.js";

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

  it.each(["rediffmail.com", "rediff.com", "yahoo.co.in", "yahoo.in", "hotmail.co.in", "outlook.in", "live.in", "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "protonmail.com", "proton.me", "zoho.com", "gmx.com", "yandex.com", "mail.com"])(
    "E2f: %s is free mail",
    (domain) => expect(corporateDomain(`someone@${domain}`)).toBeNull(),
  );

  it.each(["example.com", "example.org", "example.net", "acme.test", "x.y.example", "foo.invalid", "localhost", "box.localhost", "EXAMPLE.COM"])(
    "E2f: reserved/test domain %s is not corporate",
    (domain) => expect(corporateDomain(`someone@${domain}`)).toBeNull(),
  );

  it("E2f: a custom Zoho or example-like real domain is still corporate", () => {
    expect(corporateDomain("ravi@acme.zohomail.in")).toBe("acme.zohomail.in");
    expect(corporateDomain("ravi@examples.com")).toBe("examples.com");
    expect(corporateDomain("ravi@tatamotors.example.com")).toBe("tatamotors.example.com");
    expect(corporateDomain("ravi@testing.in")).toBe("testing.in");
    expect(isReservedDomain("contest.com")).toBe(false);
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

describe("normalizeDomain", () => {
  it.each([
    ["Acme.in", "acme.in"],
    ["https://www.Acme.co.in/about?x=1", "acme.co.in"],
    ["  sub-domain.example.com. ", "sub-domain.example.com"],
  ])("%s → %s", (input, expected) => expect(normalizeDomain(input)).toBe(expected));

  it.each(["", "acme", "not a domain", "-bad.com", "a..b.com", "acme.com:8080"])("rejects %j", (input) => expect(normalizeDomain(input)).toBeNull());
});

describe("companyMatch", () => {
  const A = { id: "a", domain: "abc.com" };
  const B = { id: "b", domain: "beta.com" };
  const byDomain = (similarity: number) => ({ ...B, similarity });

  it("placeholder -> none", () => {
    expect(companyMatch({ companyText: "Not provided", email: "x@abc.com", byName: A, byDomain: { ...A, similarity: 1 } })).toEqual({ action: "none", candidates: [] });
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
    expect(companyMatch({ companyText: "ABC", email: "r@abc.com", byName: A, byDomain: { ...A, similarity: 1 } })).toMatchObject({ action: "link", companyId: "a", candidates: [] });
    expect(companyMatch({ companyText: "ABC", email: "r@gmail.com", byName: A, byDomain: null })).toMatchObject({ action: "link", companyId: "a", candidates: [] });
    expect(companyMatch({ companyText: "ABC", email: "r@new.com", byName: { id: "a", domain: null }, byDomain: null })).toMatchObject({
      action: "link",
      companyId: "a",
      candidates: [],
    });
  });

  it("same name, domain owned by another company -> link by name + pair candidate", () => {
    expect(companyMatch({ companyText: "ABC", email: "r@beta.com", byName: A, byDomain: byDomain(0.1) })).toMatchObject({
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

  it("same domain, similar name (similarity >= 0.6) -> link by domain + contact-level candidate", () => {
    expect(companyMatch({ companyText: "Tata Motor", email: "r@beta.com", byName: null, byDomain: byDomain(0.77) })).toMatchObject({
      action: "link",
      companyId: "b",
      normalizedName: "tata motor",
      candidates: [{ otherCompanyId: null, reason: "same_domain_different_name" }],
    });
    expect(companyMatch({ companyText: "X", email: "r@beta.com", byName: null, byDomain: byDomain(0.6) }).action).toBe("link");
  });

  it("E2f name wins: same domain, different name (similarity < 0.6) -> create by name without the domain + pair candidate", () => {
    expect(companyMatch({ companyText: "TML", email: "r@beta.com", byName: null, byDomain: byDomain(0.05) })).toEqual({
      action: "create",
      normalizedName: "tml",
      domain: null,
      candidates: [{ otherCompanyId: "b", reason: "same_domain_different_name" }],
    });
    expect(companyMatch({ companyText: "Y", email: "r@beta.com", byName: null, byDomain: byDomain(0.599) }).action).toBe("create");
  });

  it("E2f: an existing company with the same name still wins over a different-name domain company", () => {
    expect(companyMatch({ companyText: "ABC", email: "r@beta.com", byName: A, byDomain: byDomain(0) })).toMatchObject({ action: "link", companyId: "a" });
  });

  it("E2f: a reserved test domain never matches by domain", () => {
    expect(companyMatch({ companyText: "Vedant Automation", email: "v@example.com", byName: null, byDomain: null })).toEqual({
      action: "create",
      normalizedName: "vedant automation",
      domain: null,
      candidates: [],
    });
  });
});
