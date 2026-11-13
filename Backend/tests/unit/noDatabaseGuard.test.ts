import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { installNoDatabaseGuard, NoDatabaseError } from "../../src/noDatabase.js";

// DEMO-1 rule 1: in a run without a database, opening a pool or client — or loading src/db.ts — stops with a clear error.
describe("no-database guard", () => {
  const undo = installNoDatabaseGuard();
  afterAll(() => undo());

  it("refuses a pool connection, a pool query and a client connection (no network attempt)", async () => {
    const pool = new pg.Pool({ connectionString: "postgres://demo@127.0.0.1:1/none" });
    await expect(pool.connect()).rejects.toBeInstanceOf(NoDatabaseError);
    await expect(pool.query("select 1")).rejects.toThrow(/no database/);
    await expect(new pg.Client({ connectionString: "postgres://demo@127.0.0.1:1/none" }).connect()).rejects.toThrow(/NORTHBEAM_NO_DATABASE=1/);
    await pool.end();
  });

  it("loading src/db.ts throws before env.ts or any pool loads", async () => {
    vi.resetModules();
    await expect(import("../../src/db.js")).rejects.toThrow(/src\/db\.ts was loaded, but this run has no database/);
  });
});
