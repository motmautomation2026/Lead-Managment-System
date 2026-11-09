import { Pool, type ClientConfig, type PoolClient, type PoolConfig } from "pg";
import { env, type DbEnvSchema } from "./env.js";
import type { z } from "zod";
import { installShutdown } from "./shutdown.js";

/**
 * Which process this is, for its pool size and application_name. Entry points
 * set NORTHBEAM_DB_ROLE before this module loads (worker.ts imports
 * ./workerRole.js first; tests and scripts set it themselves); unset = the API.
 */
export type DbRole = "api" | "worker" | "test" | "script";
const DB_ROLES: readonly DbRole[] = ["api", "worker", "test", "script"];

/** The worker's dedicated WhatsApp session-lock clients. */
export const WA_LOCK_APPLICATION_NAME = "northbeam-worker-walock";

/**
 * DB-3: TCP keepalive on every connection, so a dead peer (laptop sleep, network
 * switch) is noticed and the pooler slot is not held by a half-open socket.
 */
const KEEPALIVE = { keepAlive: true, keepAliveInitialDelayMillis: 10_000 } as const;

/** Pool settings for a role. Pure; exported for tests. */
export function poolSettings(role: DbRole, dbEnv: z.infer<typeof DbEnvSchema>): PoolConfig {
  return {
    max: role === "worker" ? dbEnv.WORKER_DB_POOL_MAX : dbEnv.DB_POOL_MAX,
    idleTimeoutMillis: dbEnv.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: dbEnv.DB_CONNECTION_TIMEOUT_MS,
    application_name: `northbeam-${role}`,
    ...KEEPALIVE,
  };
}

/**
 * The session-pooler URL (DATABASE_SESSION_URL), or DATABASE_URL when it is unset
 * (`fallback`, warned at startup). Pure; exported for tests.
 */
export function resolveDatabaseUrls(dbEnv: { DATABASE_URL: string; DATABASE_SESSION_URL?: string | undefined }) {
  const session = dbEnv.DATABASE_SESSION_URL?.trim();
  return { transaction: dbEnv.DATABASE_URL, session: session || dbEnv.DATABASE_URL, fallback: !session };
}

/** host:port of a connection string, never the user or password. */
export function describeDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}:${url.port || "5432"}`;
  } catch {
    return "(unparseable URL)";
  }
}

export const dbRole: DbRole = DB_ROLES.find((r) => r === process.env.NORTHBEAM_DB_ROLE) ?? "api";
export const databaseUrls = resolveDatabaseUrls(env);

/** Connection settings for a dedicated session pg.Client (the WhatsApp session locks): the SESSION pooler. */
export const sessionConnectionOptions: ClientConfig = {
  connectionString: databaseUrls.session,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  ...KEEPALIVE,
};

// The transaction-pooler pool: every request, worker query and transaction.
// Transactions (BEGIN/COMMIT) use one checked-out client, which is exactly what
// pool.connect() + client.query gives below; nothing here relies on session
// state (no session SET, named prepared statements, temp tables or session locks).
export const pool = new Pool({ connectionString: databaseUrls.transaction, ...poolSettings(dbRole, env) });

// The session-pooler pool, for code that needs a real session. Opens no
// connection until used (nothing uses it today; the WhatsApp locks are dedicated clients).
export const sessionPool = new Pool({
  ...sessionConnectionOptions,
  ...poolSettings(dbRole, env),
  max: env.DB_SESSION_POOL_MAX,
  application_name: `northbeam-${dbRole}-session`,
});

/** Startup log (API and worker): which pooler each pool uses, host:port only; one warning on the fallback. */
export function logPoolTargets(log: Pick<Console, "log" | "warn"> = console) {
  log.log(`[db] transaction pool → ${describeDatabaseUrl(databaseUrls.transaction)}; session pool → ${describeDatabaseUrl(databaseUrls.session)}`);
  if (databaseUrls.fallback) log.warn("[db] DATABASE_SESSION_URL is not set: the session pool and WhatsApp locks use DATABASE_URL. Set it to the session pooler (port 5432).");
}

/** Ends both pools (idempotent per pool via catch). */
export async function closePools(): Promise<void> {
  await Promise.all([pool.end().catch(() => undefined), sessionPool.end().catch(() => undefined)]);
}

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
    "The WhatsApp session-lock URL (DATABASE_SESSION_URL, or DATABASE_URL when unset) uses port 6543 (Supabase transaction pooler). " +
    "Session-level advisory locks do not work there, so WhatsApp sessions will not start. Set DATABASE_SESSION_URL to the session pooler (port 5432) or a direct connection."
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

// Scripts: Ctrl+C / Ctrl+Break / kill frees their pooler slots too (the API and worker install their own).
if (dbRole === "script") installShutdown(closePools);
