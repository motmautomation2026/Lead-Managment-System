/**
 * P7: integration runs only (vitest.config.ts). Records the run's start (database clock) and, at the
 * end, sweeps every `[test]` workspace created during this run that a file left behind (a cleanup
 * that failed on the network, a crashed file). Logged; a sweep that fails fails the run.
 */
import pg from "pg";

const PRODUCTION_REF = "jorxltfwboabyjiydyhu";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL!;
  if (url.includes(PRODUCTION_REF)) throw new Error("TEST_DATABASE_URL points at the production project; refusing.");
  const probe = new pg.Pool({ connectionString: url, max: 1 });
  const runStartedAt = (await probe.query<{ now: Date }>("select now()")).rows[0]!.now;
  await probe.end();

  return async function teardown() {
    // The app's db.js (used by deleteWorkspaceRows → deleteWorkflow) must point at the test database too.
    process.env.DATABASE_URL = url;
    process.env.NORTHBEAM_DB_ROLE = "test";
    const { pool, closePools } = await import("../src/db.js");
    const { deleteTestWorkspace } = await import("./helpers/testWorkspaces.js");
    const { withNetworkRetry } = await import("./helpers/networkRetry.js");
    try {
      const left = (
        await withNetworkRetry(() =>
          pool.query<{ id: string }>(`select id from public.workspaces where name like '[test] %' and created_at >= $1 order by created_at`, [runStartedAt]),
        )
      ).rows;
      const failed: string[] = [];
      for (const { id } of left) {
        await deleteTestWorkspace(pool, id).catch((error) => {
          failed.push(id);
          console.error(`[global teardown] ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      if (left.length) console.warn(`[global teardown] swept ${left.length - failed.length} leftover [test] workspace(s) of this run.`);
      if (failed.length) throw new Error(`[global teardown] ${failed.length} [test] workspace(s) of this run could not be deleted: ${failed.join(", ")}`);
    } finally {
      await closePools();
    }
  };
}
