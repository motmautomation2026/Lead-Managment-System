/**
 * npm run db:connections [-- --probe]
 *
 * Who is using the database's connections (Backend/.env: DATABASE_URL = transaction
 * pooler, DATABASE_SESSION_URL = session pooler; unset → DATABASE_URL).
 * Refuses the production project. Run it when you see EMAXCONNSESSION.
 *
 * 1. pg_stat_activity grouped by application_name and state. Behind the
 *    Supabase session pooler (Supavisor) every pooled server connection shows
 *    as "Supavisor", idle ones included (it keeps them warm), so this shows
 *    the pooler's server side, not which of our processes is connected.
 * 2. --probe: free client slots in BOTH poolers, measured by opening connections
 *    (up to 15 each) and closing them at once. While it runs, other new
 *    connections may briefly be refused, so it is opt-in. The transaction
 *    pooler's client limit is far above 15, so "15 of 15" there means "at least 15".
 */
import "dotenv/config";
import pg from "pg";

const PRODUCTION_REF = "jorxltfwboabyjiydyhu";
// The staging session pooler's pool_size (Supabase → Database → Connection pooling).
const POOLER_LIMIT = 15;

const url = process.env.DATABASE_URL?.trim();
if (!url) throw new Error("DATABASE_URL is not set (Backend/.env).");
const sessionUrl = process.env.DATABASE_SESSION_URL?.trim() || url;
if (url.includes(PRODUCTION_REF) || sessionUrl.includes(PRODUCTION_REF)) throw new Error("DATABASE_URL / DATABASE_SESSION_URL points at the production project; refusing.");
const options = { connectionString: url, application_name: "northbeam-script", connectionTimeoutMillis: 10_000 };
const hostPort = (u: string) => {
  const parsed = new URL(u);
  return `${parsed.hostname}:${parsed.port || "5432"}`;
};
let probing: pg.Client[] = [];
// Ctrl+C mid-probe still closes every connection it opened.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(signal, () => void Promise.all(probing.map((c) => c.end().catch(() => undefined))).finally(() => process.exit(1)));
}

async function activity() {
  const client = new pg.Client(options);
  await client.connect();
  try {
    const { rows } = await client.query<{ application_name: string; usename: string; state: string; connections: number }>(
      `select coalesce(nullif(application_name, ''), '(none)') as application_name, usename,
              coalesce(state, '(none)') as state, count(*)::int as connections
         from pg_stat_activity
        where datname = current_database() and backend_type = 'client backend'
        group by 1, 2, 3 order by 2, 1, 3`,
    );
    console.table(rows);
    const total = rows.reduce((sum, r) => sum + r.connections, 0);
    const pooled = rows.filter((r) => r.application_name === "Supavisor").reduce((sum, r) => sum + r.connections, 0);
    console.log(`Client backends: ${total} (Supavisor server connections: ${pooled} of the pooler's ${POOLER_LIMIT}; idle ones may be warm, not in use).`);
  } finally {
    await client.end();
  }
}

async function probe(label: string, connectionString: string) {
  const open: pg.Client[] = (probing = []);
  let stoppedOn: string | null = null;
  try {
    for (let i = 0; i < POOLER_LIMIT; i++) {
      const client = new pg.Client({ ...options, connectionString });
      try {
        await client.connect();
        await client.query("select 1");
        open.push(client);
      } catch (error) {
        await client.end().catch(() => undefined);
        stoppedOn = error instanceof Error ? error.message : String(error);
        break;
      }
    }
  } finally {
    await Promise.all(open.map((c) => c.end().catch(() => undefined)));
  }
  console.log(`${label} (${hostPort(connectionString)}): free client slots ${open.length} of ${POOLER_LIMIT} → in use: ${POOLER_LIMIT - open.length}.`);
  if (stoppedOn && open.length < POOLER_LIMIT) console.log(`(Stopped on: ${stoppedOn})`);
}

try {
  await activity();
} catch (error) {
  // EMAXCONNSESSION here means the pooler is full right now: that is the answer.
  console.error(`Couldn't connect: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (process.argv.includes("--probe")) {
  await probe("Session pooler", sessionUrl);
  if (sessionUrl === url) console.log("DATABASE_SESSION_URL is not set: DATABASE_URL is used for both, probed once.");
  else await probe("Transaction pooler", url);
}
else console.log("Add `-- --probe` to measure how many of the poolers' client slots are in use.");
