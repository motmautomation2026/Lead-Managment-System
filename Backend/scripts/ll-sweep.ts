/**
 * npm run ll:sweep -- --dry-run [--workspace <id>] [--since <date>]
 *
 * LL-1 safety net. --dry-run prints, per workspace, how many leads the next-action sweep would create a
 * task for (counts and workspace names only, never lead names) and writes nothing; it is read-only, so it
 * may also run against production before the release (see docs/HISTORY.md LL-1). Without --dry-run it runs
 * ONE sweep (the worker job: tasks, timeline rows, batched bells) — staging only.
 * --since overrides each workspace's agent_settings.next_action_sweep_since.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { PRODUCTION_REF, stagingProblem } from "./lib/stagingGuard.js";

export interface LlSweepArgs {
  dryRun: boolean;
  workspaceIds?: string[];
  since?: Date;
}

const USAGE = "Usage: npm run ll:sweep -- --dry-run [--workspace <id>] [--since <date>]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The parsed arguments, or why they are refused. */
export function parseLlSweepArgs(argv: string[]): LlSweepArgs | string {
  const args: LlSweepArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--workspace" || arg === "--since") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) return USAGE;
      if (arg === "--workspace") {
        if (!UUID.test(value)) return `--workspace must be a workspace id (uuid).`;
        args.workspaceIds = [...(args.workspaceIds ?? []), value];
      } else {
        const since = new Date(value);
        if (Number.isNaN(since.getTime())) return `--since must be a date (e.g. 2026-11-16 or 2026-11-16T09:00:00+05:30).`;
        args.since = since;
      }
    } else return `Unknown option ${arg}. ${USAGE}`;
  }
  return args;
}

/** Why this database must not be used for these args, or null. A dry run is read-only and allowed anywhere. */
export function llSweepDatabaseProblem(url: string | undefined, args: LlSweepArgs): string | null {
  if (!url?.trim()) return "DATABASE_URL is not set (Backend/.env).";
  if (args.dryRun) return null;
  if (url.includes(PRODUCTION_REF)) return "A real sweep never runs against production from a script (the worker does it); use --dry-run.";
  return stagingProblem(url);
}

async function main() {
  const args = parseLlSweepArgs(process.argv.slice(2));
  if (typeof args === "string") throw new Error(args);
  const problem = llSweepDatabaseProblem(process.env.DATABASE_URL, args);
  if (problem) throw new Error(problem);

  process.env.NORTHBEAM_DB_ROLE = "script";
  const { pool } = await import("../src/db.js");
  const sweep = await import("../src/services/nextAction.service.js");
  try {
    if (args.dryRun) {
      const counts = await sweep.countNextActionSweep(pool, args);
      for (const c of counts) console.log(`${c.workspaceName} (${c.workspaceId}): ${c.count} lead(s) would get a task`);
      console.log(`Dry run: ${counts.reduce((n, c) => n + c.count, 0)} lead(s) in ${counts.length} workspace(s). Nothing was written.`);
      return;
    }
    const created = await sweep.runNextActionSweep(args);
    console.log(`Next-action sweep: ${created.length} task(s) created.`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
