import { Pool, type ClientConfig, type PoolClient, type PoolConfig } from "pg";
import { env, type DbEnvSchema } from "./env.js";
import type { z } from "zod";

/**
 * Which process this is, for its pool size and application_name. Entry points
 * set NORTHBEAM_DB_ROLE before this module loads (worker.ts imports
 * ./workerRole.js first; tests and scripts set it themselves); unset = the API.
 */
export type DbRole = "api" | "worker" | "test" | "script";
const DB_ROLES: readonly DbRole[] = ["api", "worker", "test", "script"];

/** The worker's dedicated WhatsApp session-lock clients. */
export const WA_LOCK_APPLICATION_NAME = "northbeam-worker-walock";

/** Pool settings for a role. Pure; exported for tests. */
export function poolSettings(role: DbRole, dbEnv: z.infer<typeof DbEnvSchema>): PoolConfig {
  return {
    max: role === "worker" ? dbEnv.WORKER_DB_POOL_MAX : dbEnv.DB_POOL_MAX,
    idleTimeoutMillis: dbEnv.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: dbEnv.DB_CONNECTION_TIMEOUT_MS,
    application_name: `northbeam-${role}`,
  };
}

export const dbRole: DbRole = DB_ROLES.find((r) => r === process.env.NORTHBEAM_DB_ROLE) ?? "api";

/** Connection settings shared by the pool and any dedicated pg.Client (e.g. WhatsApp session locks). */
export const pgConnectionOptions: ClientConfig = {
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
};

// Single pool for the whole process. Supabase's pooled connection strings
// (pgbouncer) are fine here too, but transactions (BEGIN/COMMIT) require a
// single dedicated connection per transaction, which is exactly what
// pool.connect() + client.query gives us below — pool.query() alone would
// not guarantee the same underlying connection across statements.
export const pool = new Pool({ ...pgConnectionOptions, ...poolSettings(dbRole, env) });

/**
 * Session-level advisory locks (the WhatsApp session lock) do not work behind
 * a transaction-mode pooler: the lock lands on whichever backend served that
 * one statement. Returns why the URL is unsafe for them, or null when it is fine.
 */
export function sessionLockUnsupportedReason(databaseUrl: string): string | null {
  let port: string;
  try {
    port = new URL(databaseUrl).port;
  } catch {
    return null;
  }
  if (port !== "6543") return null;
  return (
    "DATABASE_URL uses port 6543 (Supabase transaction pooler). Session-level advisory locks do not work there, " +
    "so WhatsApp sessions will not start. Use the session pooler (port 5432) or a direct connection."
  );
}

/**
 * Runs `fn` inside a single Postgres transaction: BEGIN, then either COMMIT
 * (fn resolved) or ROLLBACK (fn threw), always releasing the client back to
 * the pool. This is how every business operation that touches more than one
 * table stays atomic (Rule 16: either the whole business change lands, or
 * none of it does).
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type DbClient = PoolClient;
