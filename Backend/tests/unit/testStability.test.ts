import { describe, expect, it, vi } from "vitest";
import { isNetworkError, withNetworkRetry } from "../helpers/networkRetry.js";
import { migrationFunctionNames, unknownFunctions } from "../../scripts/cleanup-test-workspaces.js";
import { stagingProblem } from "../../scripts/lib/stagingGuard.js";

describe("P7 test cleanup retry", () => {
  it("recognises network errors, also as a cause, and nothing else", () => {
    expect(isNetworkError(new Error("fetch failed"))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isNetworkError(new Error("getaddrinfo ENOTFOUND aws-0-ap-south-1.pooler.supabase.com"))).toBe(true);
    expect(isNetworkError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isNetworkError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isNetworkError(new Error("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }))).toBe(true);
    expect(isNetworkError(new Error("wrapper", { cause: Object.assign(new Error("connect"), { code: "ETIMEDOUT" }) }))).toBe(true);
    expect(isNetworkError(new Error('update or delete on table "leads" violates foreign key constraint'))).toBe(false);
    expect(isNetworkError(new Error("Workspace x was not deleted (not found)."))).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });

  it("retries a network error up to 3 attempts with doubling backoff, then throws it", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => void waits.push(ms);
    let calls = 0;
    await expect(
      withNetworkRetry(
        async () => {
          calls++;
          throw new Error("fetch failed");
        },
        { wait, baseMs: 100 },
      ),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(3);
    expect(waits).toEqual([100, 200]);

    calls = 0;
    const value = await withNetworkRetry(
      async () => {
        if (++calls < 3) throw Object.assign(new Error("read"), { code: "ECONNRESET" });
        return "done";
      },
      { wait },
    );
    expect(value).toBe("done");
    expect(calls).toBe(3);
  });

  it("never retries other errors", async () => {
    const fn = vi.fn(async () => {
      throw new Error("duplicate key value violates unique constraint");
    });
    await expect(withNetworkRetry(fn, { wait: async () => undefined })).rejects.toThrow("duplicate key");
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("P7 staging cleanup script", () => {
  it("refuses production and anything that isn't staging", () => {
    expect(stagingProblem("postgres://postgres.jorxltfwboabyjiydyhu:x@aws-0.pooler.supabase.com:6543/postgres")).toMatch(/production/);
    expect(stagingProblem("postgres://postgres.other:x@host:6543/postgres")).toMatch(/not the staging project/);
    expect(stagingProblem(undefined)).toMatch(/not the staging project/);
    expect(stagingProblem("postgres://postgres.arejsxqjhzotmngrobhm:x@aws-0.pooler.supabase.com:6543/postgres")).toBeNull();
  });

  it("finds functions no migration creates", () => {
    const known = migrationFunctionNames([
      "create or replace function public.set_updated_at() returns trigger as $$ begin end $$;",
      'CREATE FUNCTION "public"."handle_new_user"()\nreturns trigger',
      "create function is_active_salesperson (uid uuid) returns boolean",
    ]);
    expect([...known].sort()).toEqual(["handle_new_user", "is_active_salesperson", "set_updated_at"]);
    const strays = unknownFunctions(
      [
        { name: "set_updated_at", args: "" },
        { name: "agent3b2_fail_13361babe27d41b6813bc23eb270c202", args: "" },
        { name: "handle_new_user", args: "" },
      ],
      known,
    );
    expect(strays).toEqual([{ name: "agent3b2_fail_13361babe27d41b6813bc23eb270c202", args: "" }]);
  });
});
