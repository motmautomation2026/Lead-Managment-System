/**
 * npm run staging:cleanup-test-users [-- --confirm]
 *
 * One-off (D3 8c): DEACTIVATES active users left behind by integration tests on STAGING
 * (profiles whose email ends with @example.com; their admin audit rows are append-only, so they
 * can't be deleted). Never deletes, never touches any other address: aborts if a candidate
 * doesn't end with @example.com. Refuses unless DATABASE_URL is the staging project.
 * Default is a dry run (counts by role); --confirm applies it in one transaction.
 */
import "dotenv/config";

const PRODUCTION_REF = "jorxltfwboabyjiydyhu";
const STAGING_REF = "arejsxqjhzotmngrobhm";
const SUFFIX = "@example.com";
const confirm = process.argv.includes("--confirm");

const url = process.env.DATABASE_URL?.trim() ?? "";
if (url.includes(PRODUCTION_REF)) throw new Error("DATABASE_URL points at the production project; refusing.");
if (!url.includes(STAGING_REF)) throw new Error(`DATABASE_URL is not the staging project (${STAGING_REF}); refusing.`);

process.env.NORTHBEAM_DB_ROLE = "script";
const { pool } = await import("../src/db.js");

const counts = async () =>
  (
    await pool.query<{ role: string; active: number; inactive: number }>(
      `select role, count(*) filter (where is_active)::int as active, count(*) filter (where not is_active)::int as inactive
         from public.profiles where lower(email) like '%' || $1 group by role order by role`,
      [SUFFIX],
    )
  ).rows;

try {
  console.log("@example.com users before:", JSON.stringify(await counts()));
  const candidates = (
    await pool.query<{ id: string; email: string; role: string }>(
      `select id, email, role from public.profiles where is_active and lower(email) like '%' || $1 order by created_at`,
      [SUFFIX],
    )
  ).rows;
  // Gate: the SQL already filters, but never act on anything else.
  const stray = candidates.filter((c) => !c.email.toLowerCase().endsWith(SUFFIX));
  if (stray.length) throw new Error(`${stray.length} candidate(s) don't end with ${SUFFIX}; aborting.`);
  const byRole = candidates.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.role]: (acc[c.role] ?? 0) + 1 }), {});
  console.log(`Active ${SUFFIX} users to deactivate: ${candidates.length}`, JSON.stringify(byRole));

  if (!confirm) {
    console.log("Dry run: nothing changed. Re-run with -- --confirm to deactivate them.");
  } else if (candidates.length) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const updated = await client.query(
        `update public.profiles set is_active = false where id = any($1::uuid[]) and is_active and lower(email) like '%' || $2`,
        [candidates.map((c) => c.id), SUFFIX],
      );
      await client.query("commit");
      console.log(`Deactivated ${updated.rowCount} user(s).`);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    console.log("@example.com users after:", JSON.stringify(await counts()));
  }
} finally {
  await pool.end();
}
