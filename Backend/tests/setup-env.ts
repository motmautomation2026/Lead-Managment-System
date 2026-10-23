import { afterAll, vi } from "vitest";

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
  // Each file gets a fresh src/db.ts pool; close it so idle connections don't
  // hold session-pooler slots (15 on Supabase) into the next file.
  afterAll(async () => {
    const { pool } = await import("../src/db.js");
    await pool.end();
  });
}

process.env.DATABASE_URL ??= "postgres://postgres:postgres@127.0.0.1:5432/postgres";
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.INTEGRATION_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.NODE_ENV = "test";
