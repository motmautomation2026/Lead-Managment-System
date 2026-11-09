import { describe, expect, it } from "vitest";
import { describeDatabaseUrl, poolSettings, resolveDatabaseUrls, sessionLockUnsupportedReason } from "../../src/db.js";
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
    expect(DbEnvSchema.parse({})).toEqual({ DB_POOL_MAX: 10, WORKER_DB_POOL_MAX: 10, DB_IDLE_TIMEOUT_MS: 10_000, DB_CONNECTION_TIMEOUT_MS: 15_000, DB_SESSION_POOL_MAX: 2 });
    // A blank KEY= line means "not set".
    expect(DbEnvSchema.parse({ DB_POOL_MAX: "", WORKER_DB_POOL_MAX: "" })).toMatchObject({ DB_POOL_MAX: 10, WORKER_DB_POOL_MAX: 10 });
  });

  it("parses the staging values from strings", () => {
    expect(DbEnvSchema.parse({ DB_POOL_MAX: "5", WORKER_DB_POOL_MAX: "4", DB_IDLE_TIMEOUT_MS: "0", DB_CONNECTION_TIMEOUT_MS: "30000" })).toEqual({
      DB_POOL_MAX: 5,
      WORKER_DB_POOL_MAX: 4,
      DB_IDLE_TIMEOUT_MS: 0,
      DB_CONNECTION_TIMEOUT_MS: 30_000,
      DB_SESSION_POOL_MAX: 2,
    });
  });

  it.each([{ DB_POOL_MAX: "0" }, { WORKER_DB_POOL_MAX: "-1" }, { DB_POOL_MAX: "2.5" }, { DB_POOL_MAX: "many" }, { DB_IDLE_TIMEOUT_MS: "-5" }, { DB_POOL_MAX: "101" }, { DB_SESSION_POOL_MAX: "0" }])(
    "rejects %o",
    (bad) => {
      expect(DbEnvSchema.safeParse(bad).success).toBe(false);
    },
  );

  it("sizes and names the pool by role", () => {
    const dbEnv = DbEnvSchema.parse({ DB_POOL_MAX: "5", WORKER_DB_POOL_MAX: "4" });
    expect(poolSettings("api", dbEnv)).toEqual({
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
      application_name: "northbeam-api",
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    expect(poolSettings("worker", dbEnv)).toMatchObject({ max: 4, application_name: "northbeam-worker" });
    expect(poolSettings("test", dbEnv)).toMatchObject({ max: 5, application_name: "northbeam-test" });
    expect(poolSettings("script", dbEnv)).toMatchObject({ max: 5, application_name: "northbeam-script" });
  });
});

describe("DB-3 connection strings", () => {
  const tx = "postgres://u:secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres";
  const session = "postgres://u:secret@aws-0-ap-south-1.pooler.supabase.com:5432/postgres";

  it("uses DATABASE_SESSION_URL for the session pool when set", () => {
    expect(resolveDatabaseUrls({ DATABASE_URL: tx, DATABASE_SESSION_URL: session })).toEqual({ transaction: tx, session, fallback: false });
  });

  it.each([undefined, "", "  "])("falls back to DATABASE_URL when the session URL is %o", (value) => {
    expect(resolveDatabaseUrls({ DATABASE_URL: tx, DATABASE_SESSION_URL: value })).toEqual({ transaction: tx, session: tx, fallback: true });
  });

  it("the fallback onto the transaction pooler is refused for the WhatsApp lock", () => {
    expect(sessionLockUnsupportedReason(resolveDatabaseUrls({ DATABASE_URL: tx }).session)).toMatch(/DATABASE_SESSION_URL/);
  });

  it("describes a URL as host:port only, never the password", () => {
    expect(describeDatabaseUrl(tx)).toBe("aws-0-ap-south-1.pooler.supabase.com:6543");
    expect(describeDatabaseUrl("postgres://u:secret@db.example.co/postgres")).toBe("db.example.co:5432");
    expect(describeDatabaseUrl("nope")).not.toContain("nope");
  });

  it("the session pool and the transaction pool are separate, sized and keepalive", async () => {
    const { pool, sessionPool } = await import("../../src/db.js");
    expect(sessionPool).not.toBe(pool);
    expect(sessionPool.options).toMatchObject({ max: 2, keepAlive: true });
    expect(pool.options).toMatchObject({ keepAlive: true });
  });
});
