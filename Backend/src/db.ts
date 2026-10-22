import { Pool, type ClientConfig, type PoolClient } from "pg";
import { env } from "./env.js";

/** Connection settings shared by the pool and any dedicated pg.Client (e.g. WhatsApp session locks). */
export const pgConnectionOptions: ClientConfig = { connectionString: env.DATABASE_URL };

// Single pool for the whole process. Supabase's pooled connection strings
// (pgbouncer) are fine here too, but transactions (BEGIN/COMMIT) require a
// single dedicated connection per transaction, which is exactly what
// pool.connect() + client.query gives us below — pool.query() alone would
// not guarantee the same underlying connection across statements.
export const pool = new Pool({
  ...pgConnectionOptions,
  max: 10,
  idleTimeoutMillis: 30_000,
});

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
