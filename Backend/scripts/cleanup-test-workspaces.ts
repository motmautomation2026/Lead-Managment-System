/**
 * npm run staging:cleanup-test-workspaces [-- --confirm]
 *
 * Deletes workspaces left behind by integration tests on STAGING. Refuses unless DATABASE_URL is
 * the staging project. Default is a dry run (count, 10 sample names, the protected list, leftover
 * functions). With --confirm it deletes in batches of 50, each batch in one transaction, using the
 * same FK-safe logic as the tests (tests/helpers/testWorkspaces.ts), then removes Storage objects.
 *
 * Selected: names matching a test pattern below; P7: `[test] …` workspaces also when they still have
 * a WhatsApp connection / number row (their numbers are removed first). Never selected: the seeded
 * MOTM workspace, anything named like MOTM / MOTM Tech / Quick ICP, and any other workspace with a
 * whatsapp_connection row.
 *
 * P7: also lists functions in `public` that no migration file creates (e.g. agent3b2_fail_* left by
 * a test that crashed) and drops them only with --confirm.
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { stagingProblem } from "./lib/stagingGuard.js";

const BATCH = 50;

/** Function names the migration files create (`create [or replace] function [public.]name(`). */
export function migrationFunctionNames(sqlTexts: string[]): Set<string> {
  const names = new Set<string>();
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  for (const sql of sqlTexts) for (const m of sql.matchAll(re)) names.add(m[1]!.toLowerCase());
  return names;
}

/** Database functions in `public` that no migration creates. */
export function unknownFunctions(dbFunctions: { name: string; args: string }[], known: Set<string>) {
  return dbFunctions.filter((f) => !known.has(f.name.toLowerCase()));
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Names integration tests have used (tests/integration/*.test.ts), old and current.
const OLD_PREFIXES = [
  "agent3b", "agent3b2", "agent-024", "agent3d", "runner", "dnc-exit-test", "errors-test", "b7-test", "kb-api",
  "kb-ingest", "kb-test", "assign-test", "ingest-test", "meeting-tpl-test", "meeting-vars-test", "roles-test",
  "wa-queue-test", "wa-managers-test",
];
const TEST_NAME = `^\\[test\\] .+ ${UUID}$`; // createTestWorkspace (current)
const NAME_PATTERNS = [TEST_NAME, `^(${OLD_PREFIXES.join("|")})-${UUID}$`];
// agentContext's old workspaces: "Northbeam 1a2b3c4d" / "Other 1a2b3c4d" with slug ctx-<uuid>.
const CTX = { name: "^(Northbeam|Other) [0-9a-f]{8}$", slug: `^ctx-${UUID}$` };

// $1 = the `[test]` name pattern: a WhatsApp connection protects every other workspace.
const PROTECTED_SQL = `
  w.id = '00000000-0000-0000-0000-000000000001'
  or w.name ~* '(motm|quick ?icp)'
  or (exists (select 1 from public.whatsapp_connection c where c.workspace_id = w.id) and w.name !~ $1)`;
const MATCHES_SQL = `(w.name ~ any($2::text[]) or (w.name ~ $3 and w.slug ~ $4))`;

async function main() {
  const confirm = process.argv.includes("--confirm");
  const problem = stagingProblem(process.env.DATABASE_URL);
  if (problem) throw new Error(problem);

  process.env.NORTHBEAM_DB_ROLE = "script";
  const { pool } = await import("../src/db.js");
  const { deleteWorkspaceRows, removeStorageObjects } = await import("../tests/helpers/testWorkspaces.js");

  try {
    const selected = (
      await pool.query<{ id: string; name: string; numbers: number }>(
        `select w.id, w.name, (select count(*)::int from public.whatsapp_numbers n where n.workspace_id = w.id) as numbers
           from public.workspaces w where ${MATCHES_SQL} and not (${PROTECTED_SQL}) order by w.created_at, w.id`,
        [TEST_NAME, NAME_PATTERNS, CTX.name, CTX.slug],
      )
    ).rows;
    const protectedRows = (
      await pool.query<{ id: string; name: string; reason: string }>(
        `select w.id, w.name,
                case when w.id = '00000000-0000-0000-0000-000000000001' then 'seeded MOTM'
                     when w.name ~* '(motm|quick ?icp)' then 'name'
                     else 'has whatsapp_connection' end as reason
           from public.workspaces w where ${PROTECTED_SQL} order by w.name`,
        [TEST_NAME],
      )
    ).rows;
    const total = Number((await pool.query<{ n: string }>(`select count(*) as n from public.workspaces`)).rows[0]!.n);

    const migrationsDir = new URL("../../Supabase/migrations/", import.meta.url);
    const known = migrationFunctionNames(
      readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .map((f) => readFileSync(new URL(f, migrationsDir), "utf8")),
    );
    // Extension-owned functions (pg_trgm, vector …) are not ours to judge.
    const dbFunctions = (
      await pool.query<{ name: string; args: string }>(
        `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p
          where p.pronamespace = 'public'::regnamespace
            and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
          order by 1`,
      )
    ).rows;
    const strays = unknownFunctions(dbFunctions, known);

    console.log(
      `Workspaces: ${total}. Selected for deletion: ${selected.length} (${selected.filter((w) => w.numbers > 0).length} with WhatsApp numbers). Kept: ${total - selected.length}.`,
    );
    console.log("Sample:", selected.slice(0, 10).map((w) => w.name));
    console.log("Protected (never selected):");
    console.table(protectedRows);
    console.log(`Functions in public not created by any migration: ${strays.length}`, strays.map((f) => `${f.name}(${f.args})`));

    if (!confirm) {
      console.log("Dry run. Re-run with `-- --confirm` to delete.");
      return;
    }
    let deleted = 0;
    for (let i = 0; i < selected.length; i += BATCH) {
      const batch = selected.slice(i, i + BATCH);
      const client = await pool.connect();
      let storage: Awaited<ReturnType<typeof deleteWorkspaceRows>> = [];
      try {
        await client.query("begin");
        for (const w of batch) {
          // Numbers first: no worker picks them up again while the rows go.
          if (w.numbers) {
            await client.query(`update public.whatsapp_numbers set desired_state = 'disconnected', removed_at = coalesce(removed_at, now()) where workspace_id = $1`, [w.id]);
          }
          storage.push(...(await deleteWorkspaceRows(client, w.id)));
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        storage = [];
        throw new Error(`Batch starting at ${i} rolled back (${deleted} deleted before it): ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        client.release();
      }
      await removeStorageObjects(storage);
      deleted += batch.length;
      console.log(`Deleted ${deleted} / ${selected.length}`);
    }
    for (const f of strays) {
      // Name and argument list come from pg_proc itself, never from input.
      await pool.query(`drop function if exists public."${f.name.replaceAll('"', '""')}"(${f.args})`);
      console.log(`Dropped function public.${f.name}(${f.args})`);
    }
    const after = (await pool.query<{ active: string; total: string }>(`select count(*) filter (where is_active) as active, count(*) as total from public.workspaces`)).rows[0]!;
    console.log(`Done. Deleted ${deleted} workspace(s), ${strays.length} function(s). Workspaces now: ${after.total} (${after.active} active).`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
