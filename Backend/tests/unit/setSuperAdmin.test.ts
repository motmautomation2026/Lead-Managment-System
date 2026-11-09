import { describe, expect, it } from "vitest";
import { databaseProblem, parseSuperAdminArgs } from "../../scripts/set-super-admin.js";

describe("admin:set-super-admin refusals (E4b rule 2)", () => {
  it("refuses production, anything that isn't staging, and a missing URL", () => {
    expect(databaseProblem("postgres://postgres.jorxltfwboabyjiydyhu:x@aws-0.pooler.supabase.com:6543/postgres")).toMatch(/production/);
    expect(databaseProblem("postgres://postgres.otherproject:x@aws-0.pooler.supabase.com:6543/postgres")).toMatch(/not the staging project/);
    expect(databaseProblem(undefined)).toMatch(/not the staging project/);
    expect(databaseProblem("postgres://postgres.arejsxqjhzotmngrobhm:x@aws-0.pooler.supabase.com:6543/postgres")).toBeNull();
  });

  it("needs --email; dry run unless --confirm", () => {
    expect(parseSuperAdminArgs([])).toMatch(/Usage/);
    expect(parseSuperAdminArgs(["--email"])).toMatch(/Usage/);
    expect(parseSuperAdminArgs(["--email", "not-an-email"])).toMatch(/Usage/);
    expect(parseSuperAdminArgs(["--email", "a@b.co", "--force"])).toBe("Unknown option --force.");
    expect(parseSuperAdminArgs(["--email", "a@b.co"])).toEqual({ email: "a@b.co", remove: false, confirm: false });
    expect(parseSuperAdminArgs(["--email", "a@b.co", "--remove", "--confirm"])).toEqual({ email: "a@b.co", remove: true, confirm: true });
  });
});
