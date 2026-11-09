/**
 * DB-3: the transaction pooler (DATABASE_URL) carries every API-style query and the
 * worker ticks; the session pooler (DATABASE_SESSION_URL) only the WhatsApp session
 * locks. Skipped unless TEST_DATABASE_URL is set; the lock test also needs a session URL
 * that is not the transaction pooler (TEST_DATABASE_SESSION_URL, port 5432).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("DB-3 transaction + session poolers (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let ws: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    ws = await createTestWorkspace(pool, "db-poolers");
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await pool.end();
  });

  it("30 parallel API-style queries through the transaction pooler succeed while the session pool is at its limit", async () => {
    const db = await import("../../src/db.js");
    expect(db.databaseUrls.transaction).toBe(DATABASE_URL);
    // Hold the app's whole session pool (DB_SESSION_POOL_MAX) plus 8 more session-pooler clients.
    const held = await Promise.all(Array.from({ length: db.sessionPool.options.max! }, () => db.sessionPool.connect()));
    const extra: pg.Client[] = [];
    const wide = new Pool({ connectionString: DATABASE_URL, max: 20 });
    try {
      for (let i = 0; i < 8; i++) {
        const client = new pg.Client({ connectionString: db.databaseUrls.session });
        await client.connect();
        extra.push(client);
      }
      // The app pool (queued behind its max) and a 20-wide pool, overlapping: parameterised (unnamed) statements and a transaction.
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          i % 3 === 0
            ? db.withTransaction(async (c) => (await c.query<{ n: number }>(`select $1::int as n from pg_sleep(0.2)`, [i])).rows[0]!.n)
            : (i % 3 === 1 ? db.pool : wide).query<{ n: number }>(`select $1::int as n from pg_sleep(0.2)`, [i]).then((r) => r.rows[0]!.n),
        ),
      );
      expect(results).toEqual(Array.from({ length: 30 }, (_, i) => i));
    } finally {
      for (const client of held) client.release();
      await Promise.all(extra.map((c) => c.end().catch(() => undefined)));
      await wide.end();
    }
  });

  it("the WhatsApp session lock (session URL) still excludes a second manager", async () => {
    const db = await import("../../src/db.js");
    const { sessionLockUnsupportedReason } = db;
    if (sessionLockUnsupportedReason(db.databaseUrls.session)) {
      throw new Error("Set TEST_DATABASE_SESSION_URL to the session pooler (port 5432) to run the integration tests.");
    }
    const id = randomUUID();
    await createTestWorkspace(pool, "db-poolers-wa", { id });
    await pool.query(`insert into public.whatsapp_connection (workspace_id, desired_state, status) values ($1, 'disconnected', 'disconnected')`, [id]);

    const { BaileysManager } = await import("../../src/providers/baileys.manager.js");
    const first = new BaileysManager(id);
    const second = new BaileysManager(id);
    await first.start();
    try {
      await expect(second.start()).rejects.toThrow(/already owns this workspace's WhatsApp session/);
      expect(second.isStopped).toBe(true);
    } finally {
      await first.stop();
    }
    // Released on stop: a new manager can take it.
    const third = new BaileysManager(id);
    await third.start();
    await third.stop();
  });

  it("a worker tick (hot-score sweeper) runs correctly on the transaction pool", async () => {
    const { pool: appPool, databaseUrls } = await import("../../src/db.js");
    expect(new URL(databaseUrls.transaction).port).toBe(new URL(DATABASE_URL!).port);
    const lead = (
      await appPool.query<{ id: string }>(
        `insert into public.leads (workspace_id, first_name, company, source, email) values ($1, 'Pooler', 'Acme Steel', 'website', $2) returning id`,
        [ws, `pooler-${randomUUID().slice(0, 8)}@acmesteel.in`],
      )
    ).rows[0]!.id;
    const { runLeadScoreSweep } = await import("../../src/services/leadScore.service.js");
    expect(await runLeadScoreSweep({ workspaceId: ws })).toBe(1);
    const row = (await appPool.query(`select hot_score, hot_band, hot_score_dirty from public.leads where id = $1`, [lead])).rows[0];
    expect(row).toMatchObject({ hot_score_dirty: false });
    expect(typeof row.hot_score).toBe("number");
    expect(await runLeadScoreSweep({ workspaceId: ws })).toBe(0);
  });
});
