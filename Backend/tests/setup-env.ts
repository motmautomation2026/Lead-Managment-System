import { afterAll, beforeAll, vi } from "vitest";

// Integration tests: refuse production outright, and point the app's own pool
// (src/db.ts) at the test database so no service call can reach another DB.
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) {
  if (testDatabaseUrl.includes("jorxltfwboabyjiydyhu")) {
    throw new Error("TEST_DATABASE_URL points at the production project; refusing to run tests against it.");
  }
  process.env.DATABASE_URL = testDatabaseUrl;
  // The app's pool is named northbeam-test; PGAPPNAME names the tests' own pg Pools too.
  process.env.NORTHBEAM_DB_ROLE = "test";
  process.env.PGAPPNAME = "northbeam-test";
  // Every statement is a network round trip to the remote test database.
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  // Guard: integration tests never write leads into a real workspace (only `[test] …` ones,
  // see tests/helpers/testWorkspaces.ts). Database clock, so local clock skew doesn't matter.
  let fileStartedAt: Date | undefined;
  beforeAll(async () => {
    const { pool } = await import("../src/db.js");
    fileStartedAt = (await pool.query<{ now: Date }>("select now()")).rows[0]!.now;
  });
  // Each file gets a fresh src/db.ts pool; close it so idle connections don't
  // hold session-pooler slots (15 on Supabase) into the next file.
  // Registered first, so it runs after the file's own afterAll (cleanup).
  afterAll(async () => {
    const { pool } = await import("../src/db.js");
    try {
      if (!fileStartedAt) return;
      // D3 8c: no test user stays active (some can't be deleted: append-only admin audit rows).
      await pool.query(`update public.profiles set is_active = false where is_active and email like '%@example.com' and created_at >= $1`, [fileStartedAt]);
      // Test users all have @example.com emails and are deleted in afterAll (created_by → null);
      // real staging users have real emails, so a person adding a lead meanwhile doesn't trip this.
      const leaks = await pool.query<{ id: string; workspace: string }>(
        `select l.id, w.name as workspace from public.leads l
           join public.workspaces w on w.id = l.workspace_id
           left join public.profiles p on p.id = l.created_by
          where l.created_at >= $1 and w.name not like '[test] %'
            and (l.created_by is null or p.email like '%@example.com')`,
        [fileStartedAt],
      );
      if (leaks.rows.length) {
        throw new Error(
          `This test file wrote ${leaks.rows.length} lead(s) into a real workspace (not "[test] …"): ` +
            leaks.rows.map((r) => `${r.workspace} ${r.id}`).join(", ") +
            ". Use createTestWorkspace (tests/helpers/testWorkspaces.ts) and delete these leads.",
        );
      }
    } finally {
      await pool.end();
    }
  });
}

process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/postgres";
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.INTEGRATION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.NODE_ENV = "test";
