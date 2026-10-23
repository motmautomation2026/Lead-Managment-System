import { describe, expect, it } from "vitest";
import { poolSettings, sessionLockUnsupportedReason } from "../../src/db.js";
import { DbEnvSchema } from "../../src/env.js";

describe("sessionLockUnsupportedReason", () => {
  it("rejects the Supabase transaction pooler port 6543", () => {
    expect(sessionLockUnsupportedReason("postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres")).toMatch(
      /port 6543.*advisory locks/,
    );
  });

  it.each([
    "postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:5432/postgres",
    "postgres://u:p@db.example.supabase.co/postgres",
    "postgres://u:p@localhost:65430/postgres",
    "not a url",
  ])("allows %s", (url) => {
    expect(sessionLockUnsupportedReason(url)).toBeNull();
  });
});

describe("DB pool env", () => {
  it("defaults: pools of 10 (the old size), idle 10 s, wait up to 15 s for a connection", () => {
    expect(DbEnvSchema.parse({})).toEqual({ DB_POOL_MAX: 10, WORKER_DB_POOL_MAX: 10, DB_IDLE_TIMEOUT_MS: 10_000, DB_CONNECTION_TIMEOUT_MS: 15_000 });
    // A blank KEY= line means "not set".
    expect(DbEnvSchema.parse({ DB_POOL_MAX: "", WORKER_DB_POOL_MAX: "" })).toMatchObject({ DB_POOL_MAX: 10, WORKER_DB_POOL_MAX: 10 });
  });

  it("parses the staging values from strings", () => {
    expect(DbEnvSchema.parse({ DB_POOL_MAX: "5", WORKER_DB_POOL_MAX: "4", DB_IDLE_TIMEOUT_MS: "0", DB_CONNECTION_TIMEOUT_MS: "30000" })).toEqual({
      DB_POOL_MAX: 5,
      WORKER_DB_POOL_MAX: 4,
      DB_IDLE_TIMEOUT_MS: 0,
      DB_CONNECTION_TIMEOUT_MS: 30_000,
    });
  });

  it.each([{ DB_POOL_MAX: "0" }, { WORKER_DB_POOL_MAX: "-1" }, { DB_POOL_MAX: "2.5" }, { DB_POOL_MAX: "many" }, { DB_IDLE_TIMEOUT_MS: "-5" }, { DB_POOL_MAX: "101" }])(
    "rejects %o",
    (bad) => {
      expect(DbEnvSchema.safeParse(bad).success).toBe(false);
    },
  );

  it("sizes and names the pool by role", () => {
    const dbEnv = DbEnvSchema.parse({ DB_POOL_MAX: "5", WORKER_DB_POOL_MAX: "4" });
    expect(poolSettings("api", dbEnv)).toEqual({ max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 15_000, application_name: "northbeam-api" });
    expect(poolSettings("worker", dbEnv)).toMatchObject({ max: 4, application_name: "northbeam-worker" });
    expect(poolSettings("test", dbEnv)).toMatchObject({ max: 5, application_name: "northbeam-test" });
    expect(poolSettings("script", dbEnv)).toMatchObject({ max: 5, application_name: "northbeam-script" });
  });
});
