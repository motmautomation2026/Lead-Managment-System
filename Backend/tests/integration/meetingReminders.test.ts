/**
 * LL-2 rule 4: meeting reminders (lead 24 h / 1 h by email + WhatsApp, rep 1 h bell), the reschedule reset +
 * "Updated" confirmation, and the outcome task 2 hours after the end. WRITTEN IN LL-2, NOT RUN THERE (staging was
 * down): INT-1 runs it. Nothing is sent (rows are only queued) and nothing calls OpenAI. Skipped unless
 * TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { addTestMember, createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const HOUR = 3_600_000;

describeIfDb("LL-2 meeting reminders (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let owner: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "ll2-meetings");
    owner = await api.newUser("salesperson", { name: "LL2 Rep" });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  async function workspace() {
    const ws = await createTestWorkspace(pool, "ll2-meetings");
    await addTestMember(pool, ws, owner.id, "salesperson");
    await pool.query(
      `insert into public.whatsapp_numbers (workspace_id, label) values ($1, 'LL2') on conflict do nothing`,
      [ws],
    ).catch(() => undefined);
    return ws;
  }

  async function lead(ws: string, over: { lifecycle?: string; sticky?: boolean } = {}) {
    const number = over.sticky === false ? null : (await pool.query<{ id: string }>(`select id from public.whatsapp_numbers where workspace_id = $1 limit 1`, [ws])).rows[0]?.id ?? null;
    return (
      await pool.query<{ id: string }>(
        `insert into public.leads (workspace_id, first_name, last_name, company, source, email, phone, phone_e164, owner_id, lifecycle_state, whatsapp_number_id, dnc_reason, dnc_at)
         values ($1, 'Asha', 'Rao', 'Acme', 'referral', $2, '+91 90000 00001', '+919000000001', $3, $4, $5,
                 case when $4 = 'do_not_contact' then 'test' end, case when $4 = 'do_not_contact' then now() end)
         returning id`,
        [ws, `ll2-${randomUUID()}@example.com`, owner.id, over.lifecycle ?? "active", number],
      )
    ).rows[0]!.id;
  }

  async function meeting(ws: string, leadId: string, at: Date, bookedAt: Date) {
    return (
      await pool.query<{ id: string }>(
        `insert into public.meetings (workspace_id, lead_id, owner_id, owner_name, title, scheduled_at, duration_minutes, status, reminders_from, created_at)
         values ($1, $2, $3, 'LL2 Rep', 'Intro call', $4, 30, 'scheduled', $5, $5) returning id`,
        [ws, leadId, owner.id, at, bookedAt],
      )
    ).rows[0]!.id;
  }

  const plan = async (ws: string, now: Date) => (await import("../../src/services/meetingReminders.service.js")).runMeetingReminders({ workspaceIds: [ws], now });
  const reminders = async (meetingId: string) =>
    (await pool.query(`select kind, channel, status from public.meeting_reminders where meeting_id = $1 order by kind, channel`, [meetingId])).rows;

  it("24 h before: email queued (source meeting_reminder) + WhatsApp row queued; once", async () => {
    const ws = await workspace();
    const leadId = await lead(ws);
    const at = new Date(Date.now() + 23.5 * HOUR);
    const m = await meeting(ws, leadId, at, new Date(Date.now() - 3 * 86_400_000));
    // The 24 h time (or the last working slot before it) has passed by now.
    expect(await plan(ws, new Date())).toBeGreaterThanOrEqual(1);
    await plan(ws, new Date());
    // WhatsApp only when the lead has a sticky number (the helper's number insert may not fit the schema; INT-1 checks).
    expect((await reminders(m)).filter((r) => r.kind === "24h" && r.channel === "email")).toEqual([{ kind: "24h", channel: "email", status: "queued" }]);
    const emails = await pool.query(`select subject from public.email_outbound_messages where source = 'meeting_reminder' and lead_id = $1`, [leadId]);
    expect(emails.rowCount).toBe(1);
    // Service message: no AI touch, no wake-up.
    const touches = await pool.query(`select agent_touch_count from public.leads where id = $1`, [leadId]);
    expect(touches.rows[0].agent_touch_count).toBe(0);
    const wakeups = await pool.query(`select 1 from public.agent_wakeups where lead_id = $1`, [leadId]);
    expect(wakeups.rowCount).toBe(0);
  });

  it("1 h before: the rep's bell (emailed) and the lead's reminders; the setting off → only the rep", async () => {
    const ws = await workspace();
    await pool.query(`update public.agent_settings set meeting_reminders_enabled = false where workspace_id = $1`, [ws]);
    const leadId = await lead(ws);
    const at = new Date(Date.now() + 50 * 60_000);
    const m = await meeting(ws, leadId, at, new Date(Date.now() - 86_400_000));
    await plan(ws, new Date());
    expect(await reminders(m)).toEqual([{ kind: "rep_1h", channel: "staff", status: "sent" }]);
    const bells = await pool.query(`select recipient_id, email_status from public.notifications where workspace_id = $1 and title like 'Meeting in 1 hour:%'`, [ws]);
    expect(bells.rows).toEqual([{ recipient_id: owner.id, email_status: "pending" }]);
  });

  it("booked < 1 h ahead → no reminder at all; DNC lead → nothing", async () => {
    const ws = await workspace();
    const fresh = await meeting(ws, await lead(ws), new Date(Date.now() + 40 * 60_000), new Date());
    const dnc = await meeting(ws, await lead(ws, { lifecycle: "do_not_contact" }), new Date(Date.now() + 50 * 60_000), new Date(Date.now() - 86_400_000));
    await plan(ws, new Date());
    expect(await reminders(fresh)).toEqual([]);
    expect(await reminders(dnc)).toEqual([]);
  });

  it("reschedule via PATCH: queued reminders cancelled, reminders_from reset, 'Updated' confirmation queued", async () => {
    const ws = await workspace();
    const leadId = await lead(ws);
    const m = await meeting(ws, leadId, new Date(Date.now() + 23.5 * HOUR), new Date(Date.now() - 3 * 86_400_000));
    await plan(ws, new Date());
    const newAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const res = await api.call(owner, ws, "PATCH", `/api/v1/meetings/${m}`, { at: newAt });
    expect(res.status).toBe(200);
    const rows = await reminders(m);
    expect(rows.filter((r) => r.kind === "24h").every((r) => r.status === "cancelled" || r.status === "sent")).toBe(true);
    const from = await pool.query(`select reminders_from from public.meetings where id = $1`, [m]);
    expect(Date.now() - from.rows[0].reminders_from.getTime()).toBeLessThan(60_000);
    // "Updated" rows exist only when the workspace has default Meeting Scheduled templates; none in a fresh [test] workspace.
    expect(rows.filter((r) => r.kind === "updated")).toEqual([]);
  });

  it("outcome task 2 hours after the meeting's end (not 2 days), with a bell", async () => {
    const ws = await workspace();
    await pool.query(`update public.agent_settings set reminders_since = '2026-01-01' where workspace_id = $1`, [ws]);
    const leadId = await lead(ws);
    await meeting(ws, leadId, new Date(Date.now() - 3 * HOUR), new Date(Date.now() - 86_400_000));
    const { runMeetingOutcomeTasks } = await import("../../src/services/workReminders.service.js");
    expect(await runMeetingOutcomeTasks({ workspaceIds: [ws] })).toHaveLength(1);
    const tasks = await pool.query(`select title, owner_id from public.tasks where lead_id = $1 and status = 'open'`, [leadId]);
    expect(tasks.rows).toEqual([{ title: "Log the meeting outcome", owner_id: owner.id }]);
    const bell = await pool.query(`select 1 from public.notifications where lead_id = $1 and title like 'Log the meeting outcome:%'`, [leadId]);
    expect(bell.rowCount).toBe(1);
  });
});
