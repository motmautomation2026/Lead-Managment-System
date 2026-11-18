/**
 * npm run db:security-check
 *
 * SEC-1 guard: the browser talks only to the backend, so the anon and authenticated roles (the
 * public anon key, with or without a login token) must have no way into the database. Fails when:
 *   - a `public` table has RLS off;
 *   - any policy exists on a `public` table, or a Storage policy for anon/authenticated/public covers
 *     a private bucket (names one, or names no bucket at all);
 *   - anon/authenticated hold any privilege on a `public` table, view or sequence, or EXECUTE on a
 *     `public` function (also through PUBLIC).
 * Read-only. Uses DATABASE_URL (Backend/.env); refuses the production project. Also runs as an
 * integration test (tests/integration/dbSecurity.test.ts) so a migration can't reopen this.
 */
import dotenv from "dotenv";
import { pathToFileURL } from "node:url";
import pg from "pg";

const PRODUCTION_REF = "jorxltfwboabyjiydyhu";
export const PRIVATE_BUCKETS = ["template-attachments", "proposal-documents", "kb-documents", "agent-assets"] as const;
// Item 0 found nothing the browser or Supabase Auth needs; add `schema.name` entries here only with a reason.
const ALLOWED: readonly string[] = [];

type Queryable = Pick<pg.ClientBase, "query">;

/** Every problem found, as readable lines; empty = locked down. */
export async function securityProblems(db: Queryable): Promise<string[]> {
  const problems: string[] = [];
  const add = (rows: { item: string }[], what: string) => {
    for (const r of rows) if (!ALLOWED.includes(r.item)) problems.push(`${what}: ${r.item}`);
  };
  add(
    (await db.query(
      `select 'public.' || c.relname as item from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1`,
    )).rows,
    "RLS off",
  );
  add(
    (await db.query(
      `select format('%s on public.%s (%s)', policyname, tablename, array_to_string(roles, ',')) as item
         from pg_policies where schemaname = 'public' order by 1`,
    )).rows,
    "policy on a public table",
  );
  add(
    (await db.query(
      `select format('%s on storage.objects (%s)', policyname, array_to_string(roles, ',')) as item
         from pg_policies p, lateral (select coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr) e
        where schemaname = 'storage' and tablename = 'objects'
          and roles && array['anon', 'authenticated', 'public']::name[]
          and (e.expr !~ 'bucket_id' or e.expr ~ $1) order by 1`,
      [`(${PRIVATE_BUCKETS.join("|")})`],
    )).rows,
    "storage policy for the browser on a private bucket",
  );
  add(
    (await db.query(
      `select format('%s %s on public.%s', r.role, p.priv, c.relname) as item
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join (values ('anon'), ('authenticated')) r(role)
        cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) p(priv)
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') and has_table_privilege(r.role, c.oid, p.priv)
        union all
       select format('%s %s on sequence public.%s', r.role, p.priv, c.relname)
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join (values ('anon'), ('authenticated')) r(role)
        cross join (values ('usage'), ('select'), ('update')) p(priv)
        where n.nspname = 'public' and c.relkind = 'S' and has_sequence_privilege(r.role, c.oid, p.priv)
        union all
       select format('%s execute on public.%s', r.role, p.oid::regprocedure)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('authenticated')) r(role)
        where n.nspname = 'public' and has_function_privilege(r.role, p.oid, 'execute')
        order by 1`,
    )).rows,
    "browser privilege",
  );
  return problems;
}

async function main() {
  dotenv.config(); // only as a CLI: importing this (the integration test) must not load Backend/.env
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set (Backend/.env).");
  if (url.includes(PRODUCTION_REF)) throw new Error("DATABASE_URL points at the production project; refusing.");
  const client = new pg.Client({ connectionString: url, application_name: "northbeam-script", connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const problems = await securityProblems(client);
    if (problems.length === 0) {
      console.log("OK: no browser access to the database (RLS on, no policies, no anon/authenticated grants).");
      return;
    }
    console.error(`FAILED: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
