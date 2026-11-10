import { describe, expect, it } from "vitest";
import { parseLoadSeedArgs, sizeVerdict } from "../../scripts/load-seed.js";
import { stagingProblem } from "../../scripts/lib/stagingGuard.js";

describe("P7 staging:load-seed refusals", () => {
  it("refuses production and every database that isn't staging", () => {
    expect(stagingProblem("postgres://postgres.jorxltfwboabyjiydyhu:x@aws-0-ap-south-1.pooler.supabase.com:6543/postgres")).toMatch(/production/);
    expect(stagingProblem("postgres://postgres:postgres@127.0.0.1:5432/postgres")).toMatch(/not the staging project/);
    expect(stagingProblem("")).toMatch(/not the staging project/);
  });

  it("is a dry run unless --confirm; --remove; sizes are bounded", () => {
    expect(parseLoadSeedArgs([])).toEqual({ confirm: false, remove: false, workspaces: 10, contacts: 2000, limitMb: 500 });
    expect(parseLoadSeedArgs(["--remove", "--confirm"])).toMatchObject({ confirm: true, remove: true });
    expect(parseLoadSeedArgs(["--workspaces", "500", "--contacts", "99999"])).toMatchObject({ workspaces: 50, contacts: 10_000 });
    expect(parseLoadSeedArgs(["--contacts", "abc"])).toBe("--contacts needs a whole number.");
    expect(parseLoadSeedArgs(["--contacts", "0"])).toBe("--contacts needs a whole number.");
    expect(parseLoadSeedArgs(["--force"])).toBe("Unknown option --force.");
  });

  it("stops above 70 % of the plan limit, projected from the first workspace", () => {
    const MB = 1024 * 1024;
    expect(sizeVerdict(140 * MB, 6 * MB, 10, 500)).toMatchObject({ ok: true, projected: 200 * MB, ceiling: 350 * MB });
    expect(sizeVerdict(140 * MB, 25 * MB, 10, 500).ok).toBe(false);
    expect(sizeVerdict(351 * MB, 0, 0, 500).ok).toBe(false);
  });
});
