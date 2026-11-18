/**
 * P7 system health: /health/worker (public, no data), Settings → System health (super-admins only),
 * the stuck-vs-waiting backlog, and the daily red-flag notification (once per day per problem).
 * Staging only (`[test]` workspaces). The global heartbeat rows are restored afterwards. Nothing is sent.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Actor } from "../../src/authMiddleware.js";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("P7 system health (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let ws: string;
  let superAdmin: Actor;
  let admin: Actor;
  let savedBeats: Record<string, unknown>[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    savedBeats = (await pool.query(`select * from public.worker_heartbeats`)).rows;
    api = await startTestApi(pool, "health");
    ws = await createTestWorkspace(pool, "health");
    superAdmin = await api.newUser("admin", { superAdmin: true });
    admin = await api.newUser("admin");
    // Members of the workspace (admins get the daily notification).
    await api.call(admin, ws, "GET", "/profiles");
  });

  afterAll(async () => {
    await pool.query(`delete from public.worker_heartbeats`);
    for (const row of savedBeats) {
      const cols = Object.keys(row);
      await pool.query(`insert into public.worker_heartbeats (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
    }
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  async function freshBeats() {
    const { recordHeartbeats, WORKER_LOOPS } = await import("../../src/services/systemHealth.service.js");
    const now = new Date();
    await recordHeartbeats(
      (Object.keys(WORKER_LOOPS) as (keyof typeof WORKER_LOOPS)[]).map((loop) => ({ loop, startedAt: now, finishedAt: now, error: null, items: 0 })),
      60,
    );
  }

  it("/health/worker: 200 ok while every critical loop is fresh; a stale critical loop → 503 naming it; no workspace data", async () => {
    await freshBeats();
    let res = await fetch(`${api.origin}/health/worker`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok", stale: [] });

    // A background (non-critical) loop going stale doesn't page anyone.
    await pool.query(`update public.worker_heartbeats set last_finished_at = now() - interval '10 minutes' where loop = 'company_sweep'`);
    expect((await fetch(`${api.origin}/health/worker`)).status).toBe(200);

    await pool.query(`update public.worker_heartbeats set last_finished_at = now() - interval '4 minutes' where loop = 'agent_tick'`);
    res = await fetch(`${api.origin}/health/worker`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "stale", stale: ["agent_tick"] });
  });

  it("Settings → System health: super-admins only (403 for a workspace admin)", async () => {
    await freshBeats();
    expect((await api.call(admin, ws, "GET", "/super-admin/system-health")).status).toBe(403);
    const res = await api.call(superAdmin, ws, "GET", "/super-admin/system-health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.loops.map((l: { loop: string }) => l.loop)).toContain("email_outbound");
    expect(res.body.workspaces.find((w: { workspaceId: string }) => w.workspaceId === ws)).toMatchObject({ emailStuck: 0, red: [] });
  });

  it("backlog: due for > 15 min is stuck; held for the send window / spacing is waiting; younger rows don't count", async () => {
    const lead = (
      await pool.query<{ id: string }>(
        `insert into public.leads (workspace_id, first_name, company, source, email) values ($1, 'Health', 'Health Ltd', 'referral', $2) returning id`,
        [ws, `health-${randomUUID()}@example.com`],
      )
    ).rows[0]!.id;
    const email = (createdMin: number, dueMin: number) =>
      pool.query(
        `insert into public.email_outbound_messages (workspace_id, source, source_id, to_address, subject, html, text_body, status, created_at, next_attempt_at)
         values ($1, 'test', gen_random_uuid(), 'x@example.com', 'H', 'H', 'H', 'queued', now() - $2 * interval '1 minute', now() + $3 * interval '1 minute')`,
        [ws, createdMin, dueMin],
      );
    await email(30, -20); // stuck: due 20 min ago
    await email(30, 120); // waiting: the send window opens in 2 h
    await email(5, -10); // too young to judge
    // An AI WhatsApp send held by spacing (waiting).
    await pool.query(
      `insert into public.agent_decisions (workspace_id, lead_id, mode, action, outcome, send_status, send_next_at, created_at)
       values ($1, $2, 'live', 'send_whatsapp', 'draft', 'queued', now() + interval '1 minute', now() - interval '30 minutes')`,
      [ws, lead],
    );

    const { workspaceHealth } = await import("../../src/services/systemHealth.service.js");
    const [h] = await workspaceHealth(pool, [ws]);
    expect(h).toMatchObject({ emailStuck: 1, emailWaiting: 1, whatsappStuck: 0, whatsappWaiting: 1, red: ["stuck_queue"] });
  });

  it("daily red flag: one notification per workspace per day per problem", async () => {
    const { runHealthAlerts } = await import("../../src/services/systemHealth.service.js");
    const notifications = async () =>
      (await pool.query<{ detail: string }>(`select detail from public.notifications where workspace_id = $1 and recipient_id = $2 order by created_at`, [ws, admin.id])).rows;
    const now = new Date();

    expect(await runHealthAlerts({ workspaceIds: [ws], now })).toEqual([ws]); // the stuck email above
    expect(await runHealthAlerts({ workspaceIds: [ws], now })).toEqual([]);
    expect(await notifications()).toHaveLength(1);
    expect((await notifications())[0]!.detail).toContain("stuck in the send queue");

    // A new problem the same day: one more notification, naming only it.
    await pool.query(`insert into public.whatsapp_numbers (workspace_id, label, enabled, paused_reason) values ($1, 'Paused #1', false, 'Test pause')`, [ws]);
    expect(await runHealthAlerts({ workspaceIds: [ws], now })).toEqual([ws]);
    const list = await notifications();
    expect(list).toHaveLength(2);
    expect(list[1]!.detail).toContain("paused");
    expect(list[1]!.detail).not.toContain("stuck");
    expect(await runHealthAlerts({ workspaceIds: [ws], now })).toEqual([]);

    // The next IST day: still red → one notification again.
    expect(await runHealthAlerts({ workspaceIds: [ws], now: new Date(now.getTime() + 86_400_000) })).toEqual([ws]);
    expect(await notifications()).toHaveLength(3);
  });
});
