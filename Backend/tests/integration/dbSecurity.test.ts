/**
 * SEC-1: the browser has no direct database access.
 * 1. `db:security-check` finds nothing (RLS on, no policies, no anon/authenticated grants), so a
 *    future migration can't reopen PostgREST access unnoticed.
 * 2. Proof through Supabase itself: with the staging anon key, both without a login and with a
 *    signed-in active user's token, PostgREST reads/inserts/RPCs are refused and a private Storage
 *    bucket lists nothing. Login still works. Needs SUPABASE_URL + TEST_SUPABASE_ANON_KEY (the
 *    staging runner passes both).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { securityProblems } from "../../scripts/db-security-check.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
const ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const describeIfSupabase = DATABASE_URL && ANON_KEY && SUPABASE_URL && !SUPABASE_URL.includes("example.supabase.co") ? describe : describe.skip;

describeIfDb("SEC-1 db:security-check (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("finds no browser access: RLS on everywhere, no policies, no anon/authenticated grants", async () => {
    expect(await securityProblems(pool)).toEqual([]);
  });
});

describeIfSupabase("SEC-1 Supabase REST + Storage refuse the browser (requires TEST_SUPABASE_ANON_KEY)", () => {
  let userId: string | undefined;
  let userToken = "";

  const call = async (token: string | null, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      method,
      headers: { apikey: ANON_KEY!, Authorization: `Bearer ${token ?? ANON_KEY}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as unknown) : undefined };
  };

  beforeAll(async () => {
    const { supabaseAdmin } = await import("../../src/supabaseAdmin.js");
    const email = `sec1-${randomUUID()}@example.com`;
    const password = `Sec1-${randomUUID()}`;
    const created = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    userId = created.data.user.id;
    // An active salesperson: exactly who the old is_active_salesperson() policies let in.
    const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      await pool.query(`update public.profiles set is_active = true, role = 'salesperson' where id = $1`, [userId]);
    } finally {
      await pool.end();
    }
    const login = await call(null, "POST", "/auth/v1/token?grant_type=password", { email, password });
    expect(login.status, "login still works").toBe(200);
    userToken = (login.body as { access_token: string }).access_token;
    expect(userToken).toBeTruthy();
  });

  afterAll(async () => {
    if (!userId) return;
    const { supabaseAdmin } = await import("../../src/supabaseAdmin.js");
    await supabaseAdmin.auth.admin.deleteUser(userId);
  });

  for (const who of ["anon key only", "signed-in user"] as const) {
    const token = () => (who === "anon key only" ? null : userToken);

    it(`${who}: PostgREST reads of leads and tasks are refused`, async () => {
      for (const table of ["leads", "tasks"]) {
        const res = await call(token(), "GET", `/rest/v1/${table}?select=id&limit=5`);
        expect(res.status, `${table}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(400);
      }
    });

    it(`${who}: a PostgREST insert and an RPC are refused`, async () => {
      const insert = await call(token(), "POST", "/rest/v1/tasks", { title: "sec1 probe" });
      expect(insert.status, JSON.stringify(insert.body)).toBeGreaterThanOrEqual(400);
      const rpc = await call(token(), "POST", "/rest/v1/rpc/is_active_salesperson", {});
      expect(rpc.status, JSON.stringify(rpc.body)).toBeGreaterThanOrEqual(400);
    });

    it(`${who}: a private Storage bucket lists nothing`, async () => {
      const res = await call(token(), "POST", "/storage/v1/object/list/proposal-documents", { prefix: "", limit: 10 });
      if (res.status < 400) expect(res.body).toEqual([]);
    });
  }
});
