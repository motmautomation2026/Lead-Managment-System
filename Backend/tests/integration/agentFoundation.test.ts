/**
 * Migration 024 (AI agent foundation): settings seeded per workspace, new
 * leads.agent_* defaults, task_origin 'agent'. Runs against a REAL database;
 * skipped unless TEST_DATABASE_URL is set. Cleans up its own workspace.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("AI agent foundation, migration 024 (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  const WORKSPACE_ID = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`insert into public.workspaces (id, name, slug) values ($1, $2, $2)`, [WORKSPACE_ID, `agent-024-${WORKSPACE_ID}`]);
  });

  afterAll(async () => {
    await pool.query(`delete from public.tasks where workspace_id = $1`, [WORKSPACE_ID]).catch(() => undefined);
    await pool.query(`delete from public.leads where workspace_id = $1`, [WORKSPACE_ID]).catch(() => undefined);
    await pool.query(`delete from public.workspaces where id = $1`, [WORKSPACE_ID]).catch((error) => console.warn("[agent024] cleanup failed:", error));
    await pool.end();
  });

  it("every workspace has an agent_settings row", async () => {
    const missing = await pool.query(
      `select count(*)::int as n from public.workspaces w where not exists (select 1 from public.agent_settings s where s.workspace_id = w.id)`,
    );
    expect(missing.rows[0].n).toBe(0);
  });

  it("a new workspace gets default settings (mode off) from the insert trigger", async () => {
    const result = await pool.query(`select * from public.agent_settings where workspace_id = $1`, [WORKSPACE_ID]);
    expect(result.rows[0]).toMatchObject({
      mode: "off",
      send_days: [1, 2, 3, 4, 5, 6],
      send_window_start: "09:30:00",
      send_window_end: "19:00:00",
      min_gap_hours: 48,
      max_touches_7d: 2,
      max_touches_total: 8,
      wake_min_days: 1,
      wake_max_days: 30,
      nurture_long_term: false,
      whatsapp_opt_out_text: "Reply STOP to opt out.",
    });
  });

  it("rejects invalid settings (window order, weekday range)", async () => {
    await expect(
      pool.query(`update public.agent_settings set send_window_start = '20:00' where workspace_id = $1`, [WORKSPACE_ID]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(`update public.agent_settings set send_days = '{0,1}' where workspace_id = $1`, [WORKSPACE_ID]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("new leads default to agent_status none with no touches, and task_origin accepts 'agent'", async () => {
    const lead = await pool.query(
      `insert into public.leads (workspace_id, first_name, company, source, email) values ($1, 'Agent', 'Agent Co', 'referral', $2)
       returning id, agent_status, agent_status_reason, agent_status_changed_at, agent_touch_count, agent_last_touch_at`,
      [WORKSPACE_ID, `agent-${randomUUID()}@example.com`],
    );
    expect(lead.rows[0]).toMatchObject({
      agent_status: "none",
      agent_status_reason: null,
      agent_status_changed_at: null,
      agent_touch_count: 0,
      agent_last_touch_at: null,
    });

    const task = await pool.query(
      `insert into public.tasks (workspace_id, lead_id, task_type, title, due_at, origin) values ($1, $2, 'follow_up', 'Agent handoff', now(), 'agent') returning origin`,
      [WORKSPACE_ID, lead.rows[0].id],
    );
    expect(task.rows[0].origin).toBe("agent");
  });
});
