/**
 * npm run admin:set-super-admin -- --email <email> [--remove] [--confirm]
 *
 * E4b rule 2: the ONLY way to make someone a super-admin (profiles.is_super_admin) or remove it; no UI
 * can. STAGING only: refuses unless DATABASE_URL is the staging project (and always refuses production).
 * Dry run by default (prints the user and the change); --confirm writes it, with an admin audit row.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";

export const PRODUCTION_REF = "jorxltfwboabyjiydyhu";
export const STAGING_REF = "arejsxqjhzotmngrobhm";

export interface SuperAdminArgs {
  email: string;
  remove: boolean;
  confirm: boolean;
}

/** The parsed arguments, or why they are refused. */
export function parseSuperAdminArgs(argv: string[]): SuperAdminArgs | string {
  const known = new Set(["--email", "--remove", "--confirm"]);
  const unknown = argv.find((arg, i) => arg.startsWith("--") && !known.has(arg) && argv[i - 1] !== "--email");
  if (unknown) return `Unknown option ${unknown}.`;
  const at = argv.indexOf("--email");
  const email = at >= 0 ? argv[at + 1]?.trim() : undefined;
  if (!email || email.startsWith("--") || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Usage: npm run admin:set-super-admin -- --email <email> [--remove] [--confirm]";
  return { email, remove: argv.includes("--remove"), confirm: argv.includes("--confirm") };
}

/** Why this database must not be touched, or null for staging. */
export function databaseProblem(url: string | undefined): string | null {
  const value = url?.trim() ?? "";
  if (value.includes(PRODUCTION_REF)) return "DATABASE_URL points at the production project; refusing. Production has no script flow (see docs/HISTORY.md E4b).";
  if (!value.includes(STAGING_REF)) return `DATABASE_URL is not the staging project (${STAGING_REF}); refusing.`;
  return null;
}

async function main() {
  const args = parseSuperAdminArgs(process.argv.slice(2));
  if (typeof args === "string") throw new Error(args);
  const problem = databaseProblem(process.env.DATABASE_URL);
  if (problem) throw new Error(problem);

  process.env.NORTHBEAM_DB_ROLE = "script";
  const { pool } = await import("../src/db.js");
  try {
    const user = (
      await pool.query<{ id: string; full_name: string; email: string; is_active: boolean; is_super_admin: boolean }>(
        `select id, full_name, email, is_active, is_super_admin from public.profiles where lower(email) = lower($1)`,
        [args.email],
      )
    ).rows[0];
    if (!user) throw new Error(`No user with the email ${args.email}.`);
    if (!args.remove && !user.is_active) throw new Error(`${user.email} is deactivated; refusing to make them a super-admin.`);
    const target = !args.remove;
    console.log(`${user.full_name} <${user.email}>: super-admin ${user.is_super_admin ? "yes" : "no"} → ${target ? "yes" : "no"}`);
    if (user.is_super_admin === target) {
      console.log("Nothing to change.");
      return;
    }
    if (!args.confirm) {
      console.log("Dry run: nothing changed. Re-run with -- --confirm to apply it.");
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`update public.profiles set is_super_admin = $2 where id = $1`, [user.id, target]);
      await client.query(
        `insert into public.admin_audit_events (actor_id, actor_email, action, target_type, target_id, metadata)
         values (null, 'script:admin:set-super-admin', $1, 'profile', $2, $3)`,
        [target ? "profile.super_admin_set" : "profile.super_admin_removed", user.id, { email: user.email }],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    console.log(`Done: ${user.email} is ${target ? "now" : "no longer"} a super-admin.`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
