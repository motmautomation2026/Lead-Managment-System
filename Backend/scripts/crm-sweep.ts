/**
 * npm run crm:sweep -- --once
 *
 * Runs ONE company-sweeper pass (the same code as the worker tick, up to 200
 * contacts) against STAGING and prints counts only, never names.
 * Refuses anything but the staging project. Production is backfilled by its own
 * worker after the release, never by this script.
 */
import "dotenv/config";

const PRODUCTION_REF = "jorxltfwboabyjiydyhu";
const STAGING_REF = "arejsxqjhzotmngrobhm";

const url = process.env.DATABASE_URL?.trim();
if (!url) throw new Error("DATABASE_URL is not set (Backend/.env).");
if (url.includes(PRODUCTION_REF)) throw new Error("DATABASE_URL points at the production project; refusing.");
if (!url.includes(STAGING_REF)) throw new Error(`DATABASE_URL is not the staging project (${STAGING_REF}); refusing.`);
if (!process.argv.includes("--once")) throw new Error("Usage: npm run crm:sweep -- --once");

process.env.NORTHBEAM_DB_ROLE = "script";
const { pool } = await import("../src/db.js");
const { runCompanySweep } = await import("../src/services/companies.service.js");
try {
  const counts = await runCompanySweep();
  console.log(`Company sweep: ${counts.processed} contact(s) processed, ${counts.created} companies created, ${counts.linked} linked to an existing company, ${counts.none} without a company, ${counts.failed} failed.`);
} finally {
  await pool.end();
}
