/**
 * npm run crm:deal-sweep -- --once
 *
 * Runs ONE deal-sweeper pass (the same code as the worker tick, up to 100
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
if (!process.argv.includes("--once")) throw new Error("Usage: npm run crm:deal-sweep -- --once");

process.env.NORTHBEAM_DB_ROLE = "script";
const { pool } = await import("../src/db.js");
const { runDealSweep } = await import("../src/services/deals.service.js");
try {
  const counts = await runDealSweep();
  console.log(`Deal sweep: ${counts.processed} contact(s) processed, ${counts.created} deals created, ${counts.attachedMeetings} meetings and ${counts.attachedProposals} proposals attached, ${counts.failed} failed, ${counts.workspacesCompleted} workspace(s) marked backfilled.`);
} finally {
  await pool.end();
}
