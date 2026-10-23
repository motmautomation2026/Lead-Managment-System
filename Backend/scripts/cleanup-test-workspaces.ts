/**
 * npm run staging:cleanup-test-workspaces [-- --confirm]
 *
 * One-off: deletes workspaces left behind by integration tests on STAGING.
 * Refuses unless DATABASE_URL is the staging project. Default is a dry run
 * (count, 10 sample names, the protected list). With --confirm it deletes in
 * batches of 50, each batch in one transaction, using the same FK-safe logic
 * as the tests (tests/helpers/testWorkspaces.ts), then removes Storage objects.
 *
 * Selected: names matching a test pattern below. Never selected: the seeded
 * MOTM workspace, anything named like MOTM / MOTM Tech / Quick ICP, and any
 * workspace with a whatsapp_connection row.
 */
import "dotenv/config";

const PRODUCTION_REF = "jorxltfwboabyjiydyhu";
const STAGING_REF = "arejsxqjhzotmngrobhm";
const BATCH = 50;
const confirm = process.argv.includes("--confirm");

const url = process.env.DATABASE_URL?.trim() ?? "";
if (url.includes(PRODUCTION_REF)) throw new Error("DATABASE_URL points at the production project; refusing.");
if (!url.includes(STAGING_REF)) throw new Error(`DATABASE_URL is not the staging project (${STAGING_REF}); refusing.`);

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Names integration tests have used (tests/integration/*.test.ts), old and current.
const OLD_PREFIXES = [
  "agent3b", "agent3b2", "agent-024", "agent3d", "runner", "dnc-exit-test", "errors-test", "b7-test", "kb-api",
  "kb-ingest", "kb-test", "assign-test", "ingest-test", "meeting-tpl-test", "meeting-vars-test", "roles-test",
  "wa-queue-test", "wa-managers-test",
];
const NAME_PATTERNS = [
  `^\\[test\\] .+ ${UUID}$`, // createTestWorkspace (current)
  `^(${OLD_PREFIXES.join("|")})-${UUID}$`,
];
// agentContext's old workspaces: "Northbeam 1a2b3c4d" / "Other 1a2b3c4d" with slug ctx-<uuid>.
const CTX = { name: "^(Northbeam|Other) [0-9a-f]{8}$", slug: `^ctx-${UUID}$` };

const PROTECTED_SQL = `
  w.id = '00000000-0000-0000-0000-000000000001'
  or w.name ~* '(motm|quick ?icp)'
  or exists (select 1 from public.whatsapp_connection c where c.workspace_id = w.id)`;
const MATCHES_SQL = `(w.name ~ any($1::text[]) or (w.name ~ $2 and w.slug ~ $3))`;
const params = [NAME_PATTERNS, CTX.name, CTX.slug];

process.env.NORTHBEAM_DB_ROLE = "script";
const { pool } = await import("../src/db.js");
const { deleteWorkspaceRows, removeStorageObjects } = await import("../tests/helpers/testWorkspaces.js");

try {
  const selected = (
    await pool.query<{ id: string; name: string }>(
      `select w.id, w.name from public.workspaces w where ${MATCHES_SQL} and not (${PROTECTED_SQL}) order by w.created_at, w.id`,
      params,
    )
  ).rows;
  const protectedRows = (
    await pool.query<{ id: string; name: string; reason: string }>(
      `select w.id, w.name,
              case when w.id = '00000000-0000-0000-0000-000000000001' then 'seeded MOTM'
                   when w.name ~* '(motm|quick ?icp)' then 'name'
                   else 'has whatsapp_connection' end as reason
         from public.workspaces w where ${PROTECTED_SQL} order by w.name`,
    )
  ).rows;
  const total = Number((await pool.query<{ n: string }>(`select count(*) as n from public.workspaces`)).rows[0]!.n);

  console.log(`Workspaces: ${total}. Selected for deletion: ${selected.length}. Kept: ${total - selected.length}.`);
  console.log("Sample:", selected.slice(0, 10).map((w) => w.name));
  console.log("Protected (never selected):");
  console.table(protectedRows);

  if (!confirm) {
    console.log("Dry run. Re-run with `-- --confirm` to delete.");
  } else {
    let deleted = 0;
    for (let i = 0; i < selected.length; i += BATCH) {
      const batch = selected.slice(i, i + BATCH);
      const client = await pool.connect();
      let storage: Awaited<ReturnType<typeof deleteWorkspaceRows>> = [];
      try {
        await client.query("begin");
        for (const w of batch) storage.push(...(await deleteWorkspaceRows(client, w.id)));
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
    const after = (await pool.query<{ active: string; total: string }>(`select count(*) filter (where is_active) as active, count(*) as total from public.workspaces`)).rows[0]!;
    console.log(`Done. Deleted ${deleted}. Workspaces now: ${after.total} (${after.active} active).`);
  }
} finally {
  await pool.end();
}
