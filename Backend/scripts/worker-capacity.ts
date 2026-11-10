/**
 * npm run staging:worker-capacity   (P7 rule 6; STAGING only, needs staging:load-seed)
 *
 * Measures what each WhatsApp number costs the worker, with FAKE managers: a BaileysManager object that
 * is never started (no Baileys socket, nothing sent) plus the one thing a started manager always holds —
 * its session-lock client (a dedicated connection with the number's advisory lock), exactly as
 * BaileysManager.start() opens it. Runs 1, 10 and 20 numbers (the load-seed numbers); lock clients go to
 * the session pooler while it has free slots, the rest to the transaction pooler (same client cost; the
 * session pooler's 15 clients is the real limit, see the slot formula). Prints RSS / heap deltas and the
 * connections it held.
 */
import "dotenv/config";
import pg from "pg";
import { stagingProblem } from "./lib/stagingGuard.js";
import { LOAD_SEED_LABEL } from "./load-seed.js";

const gc = (globalThis as { gc?: () => void }).gc;
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

async function main() {
  const problem = stagingProblem(process.env.DATABASE_URL);
  if (problem) throw new Error(problem);
  if (!gc) throw new Error("Run with node --expose-gc (the npm script does).");
  process.env.NORTHBEAM_DB_ROLE = "script";
  const { pool } = await import("../src/db.js");
  const { databaseUrls } = await import("../src/db.js");
  const { BaileysManager } = await import("../src/providers/baileys.manager.js");
  const numbers = (
    await pool.query<{ id: string; workspace_id: string }>(
      `select n.id, n.workspace_id from public.whatsapp_numbers n join public.workspaces w on w.id = n.workspace_id
        where w.name like $1 and n.removed_at is null order by n.created_at limit 20`,
      [`[test] ${LOAD_SEED_LABEL} %`],
    )
  ).rows;
  if (numbers.length < 20) throw new Error("Needs the 20 load-seed numbers: npm run staging:load-seed -- --confirm.");

  const freeSessionSlots = 15 - 2 - 2; // leave room for this script's own pool and the dashboard
  const rows: string[] = [];
  for (const n of [1, 10, 20]) {
    for (let i = 0; i < 3; i++) gc();
    const before = process.memoryUsage();
    const held: { manager: unknown; lock: pg.Client }[] = [];
    let session = 0;
    for (const num of numbers.slice(0, n)) {
      const onSession = session < freeSessionSlots;
      const lock = new pg.Client({ connectionString: onSession ? databaseUrls.session : databaseUrls.transaction, keepAlive: true });
      await lock.connect();
      if (onSession) {
        session++;
        const got = (await lock.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtextextended($1, 1)) as ok`, [num.id])).rows[0]!.ok;
        if (!got) throw new Error(`Number ${num.id} is locked by a running worker; stop it first.`);
      }
      held.push({ manager: new BaileysManager(num.workspace_id, num.id), lock });
    }
    for (let i = 0; i < 3; i++) gc();
    const after = process.memoryUsage();
    // pg_stat_activity can't count them: behind Supavisor every client shows as a shared "Supavisor" backend.
    rows.push(
      `| ${n} | ${mb(after.rss - before.rss)} | ${mb(after.heapUsed - before.heapUsed)} | ${((after.heapUsed - before.heapUsed) / n / 1024).toFixed(0)} KB | ${n} (${session} session pooler, ${n - session} transaction stand-in) |`,
    );
    for (const h of held) await h.lock.end();
  }
  console.log("| numbers | RSS Δ MB | heap Δ MB | heap per number | DB clients held (one per number) |");
  console.log("|---:|---:|---:|---:|---|");
  for (const r of rows) console.log(r);
  await pool.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
