import { describe, expect, it } from "vitest";
import { normalizePhoneE164 } from "../../src/domain/phone.js";
import { assertStagingDatabase, SCENARIOS, seedEmail, seedPhone } from "../../scripts/seed-ai-test-contacts.js";

describe("seed-ai-test-contacts", () => {
  it("refuses production and anything that isn't the staging ref", () => {
    expect(() => assertStagingDatabase("postgres://u:p@db.jorxltfwboabyjiydyhu.supabase.co/postgres")).toThrow(/production/);
    expect(() => assertStagingDatabase("postgres://postgres.jorxltfwboabyjiydyhu:x@arejsxqjhzotmngrobhm.pooler/postgres")).toThrow(/production/);
    expect(() => assertStagingDatabase("postgres://localhost/postgres")).toThrow(/not the staging/);
    expect(() => assertStagingDatabase(undefined)).toThrow(/not the staging/);
    expect(() => assertStagingDatabase("postgres://postgres.arejsxqjhzotmngrobhm:x@pooler.supabase.com:5432/postgres")).not.toThrow();
  });

  it("has 20 scenarios with unique, valid fake contact details", () => {
    expect(SCENARIOS).toHaveLength(20);
    const phones = SCENARIOS.map((s) => normalizePhoneE164(seedPhone(s)));
    expect(phones.every((p) => p && /^\+9190000000\d\d$/.test(p))).toBe(true);
    expect(new Set(phones).size).toBe(20);
    const emails = SCENARIOS.map(seedEmail).filter((e): e is string => e !== null);
    expect(emails.every((e) => e.endsWith("@example.com"))).toBe(true);
    expect(new Set(emails).size).toBe(emails.length);
    // Only the "name + phone only" thin lead goes without an email.
    expect(SCENARIOS.filter((s) => seedEmail(s) === null).map((s) => s.scenario)).toEqual(["Thin website lead: name + phone only, no message"]);
  });

  it("covers the designed situations", () => {
    const count = (re: RegExp) => SCENARIOS.filter((s) => re.test(s.scenario)).length;
    expect(count(/^Website:/)).toBe(6);
    expect(count(/^Thin website lead/)).toBe(2);
    expect(count(/^Non-engineering B2B/)).toBe(2);
    expect(count(/^Consumer business/)).toBe(1);
    expect(count(/^After call/)).toBe(3);
    expect(count(/^Objection note/)).toBe(2);
    expect(count(/^Price question/)).toBe(1);
    expect(count(/^Pune company/)).toBe(1);
    expect(count(/^Meeting completed/)).toBe(1);
    expect(count(/^Proposal sent/)).toBe(1);
    // Website leads carry the form's Industry line; manual leads a source.
    for (const s of SCENARIOS) {
      if (s.website) expect(s.lead).toBeUndefined();
      else expect(s.lead?.source).toBeTruthy();
    }
  });
});
