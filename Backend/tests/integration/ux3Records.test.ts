/**
 * UX-3 backend additions through the HTTP stack: a note written on a deal (POST /leads/:id/notes `dealId`), meeting
 * reminders that went to the lead in the contact's Meetings & proposals feed, and Home "My day" (GET /home/summary:
 * replies, calls, "Decide the next step", overdue; admins: team row + red flags). Nothing is sent (fake WhatsApp
 * sender), nothing calls OpenAI. Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type JsonBody, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";
import { REPLY_TASK_TITLES } from "../../src/agent/replyClassification.js";
import { DECIDE_NEXT_STEP_TITLE } from "../../src/domain/nextAction.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const HOUR = 3_600_000;

describeIfDb("UX-3 records + Home (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let repA: Actor;
  let repB: Actor;
  let admin: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "ux3-records");
    repA = await api.newUser("salesperson", { name: "UX3 Rep A" });
    repB = await api.newUser("salesperson", { name: "UX3 Rep B" });
    admin = await api.newUser("admin", { name: "UX3 Admin" });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  async function lead(ws: string, ownerId: string, name = "Asha") {
    return (
      await pool.query<{ id: string }>(
        `insert into public.leads (workspace_id, first_name, last_name, company, source, email, phone, phone_e164, owner_id)
         values ($1, $2, 'Rao', 'Acme Steel', 'referral', $3, $4, $4, $5) returning id`,
        [ws, name, `ux3-${randomUUID()}@example.com`, `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, ownerId],
      )
    ).rows[0]!.id;
  }
  async function task(ws: string, leadId: string, ownerId: string, over: { title: string; type?: string; origin?: string; dueAt: Date }) {
    await pool.query(
      `insert into public.tasks (workspace_id, lead_id, owner_id, task_type, title, due_at, origin, status)
       values ($1, $2, $3, ($4::text)::public.task_type, $5, $6, ($7::text)::public.task_origin, 'open')`,
      [ws, leadId, ownerId, over.type ?? "follow_up", over.title, over.dueAt, over.origin ?? "manual"],
    );
  }

  it("a note on a deal is the contact's note and shows in the deal's feed under Notes; another contact's deal is refused", async () => {
    const ws = await createTestWorkspace(pool, "ux3-note");
    const leadId = await lead(ws, repA.id);
    const otherLead = await lead(ws, repA.id, "Ravi");
    const deal = async (l: string) =>
      (await pool.query<{ id: string }>(`insert into public.deals (workspace_id, name, lead_id, stage, source) values ($1, 'Fleet', $2, 'qualified', 'manual') returning id`, [ws, l])).rows[0]!.id;
    const dealId = await deal(leadId);
    const otherDeal = await deal(otherLead);

    const res = await api.call(repA, ws, "POST", `/leads/${leadId}/notes`, { body: "PO expected Friday", dealId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const feed = await api.call(repA, ws, "GET", `/deals/${dealId}/timeline?kind=notes`);
    expect(feed.status).toBe(200);
    expect(feed.body.data.map((e: JsonBody) => [e.title, e.detail])).toEqual([["Note Added", "PO expected Friday"]]);
    const contactNotes = await api.call(repA, ws, "GET", `/contacts/${leadId}/timeline?kind=notes`);
    expect(contactNotes.body.data).toHaveLength(1);

    expect((await api.call(repA, ws, "POST", `/leads/${leadId}/notes`, { body: "Wrong deal", dealId: otherDeal })).status).toBe(400);
    expect((await api.call(repA, ws, "POST", `/leads/${leadId}/notes`, { body: "Bad id", dealId: "nope" })).status).toBe(400);
  });

  it("a meeting reminder sent on WhatsApp is in the contact's Meetings & proposals feed (own kind, not a touch); a dry run is not", async () => {
    const ws = await createTestWorkspace(pool, "ux3-reminder");
    const leadId = await lead(ws, repA.id);
    const meetingAt = new Date(Date.now() + 24 * HOUR);
    const meeting = (
      await pool.query<{ id: string }>(
        `insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status) values ($1, $2, $3, 'Discovery', $4, 'scheduled') returning id`,
        [ws, leadId, repA.id, meetingAt],
      )
    ).rows[0]!.id;
    const reminder = async (kind: string) =>
      (
        await pool.query<{ id: string; workspace_id: string; meeting_id: string; lead_id: string; kind: string; meeting_at: Date; body: string }>(
          `insert into public.meeting_reminders (workspace_id, meeting_id, lead_id, kind, channel, meeting_at, status, body)
           values ($1, $2, $3, $4, 'whatsapp', $5, 'sending', 'See you tomorrow.') returning id, workspace_id, meeting_id, lead_id, kind, meeting_at, body`,
          [ws, meeting, leadId, kind, meetingAt],
        )
      ).rows[0]!;
    const { processReminderWhatsappSend } = await import("../../src/services/meetingReminders.service.js");
    const sends: string[] = [];
    expect(await processReminderWhatsappSend(await reminder("24h"), { send: async (_ws, input) => (sends.push(input.body), { providerMessageId: "fake-1" }) })).toBe("sent");
    expect(sends).toEqual(["See you tomorrow."]);
    expect(await processReminderWhatsappSend(await reminder("updated"), { dryRun: true })).toBe("dry_run");

    const feed = await api.call(repA, ws, "GET", `/contacts/${leadId}/timeline?kind=meetings&kind=proposals`);
    expect(feed.status).toBe(200);
    expect(feed.body.data.map((e: JsonBody) => [e.title, e.detail, e.relatedMeetingId])).toEqual([["Meeting reminder sent (24 h before)", "On WhatsApp", meeting]]);
    const row = await pool.query(`select event_kind from public.timeline_events where lead_id = $1 and title like 'Meeting reminder%'`, [leadId]);
    expect(row.rows).toEqual([{ event_kind: "meeting_reminder" }]);
    expect((await api.call(repA, ws, "GET", `/contacts/${leadId}/timeline?kind=messages`)).body.data).toEqual([]);
  });

  it("Home: each card's count + top items for the signed-in rep only; admins get the team row and red flags", async () => {
    const ws = await createTestWorkspace(pool, "ux3-home");
    const a = await lead(ws, repA.id);
    const b = await lead(ws, repB.id, "Ravi");
    await task(ws, a, repA.id, { title: REPLY_TASK_TITLES[0]!, origin: "agent", dueAt: new Date(Date.now() + HOUR) });
    await task(ws, a, repA.id, { title: "Call back", type: "call", dueAt: new Date(Date.now() - 2 * HOUR) });
    await task(ws, a, repA.id, { title: DECIDE_NEXT_STEP_TITLE, dueAt: new Date(Date.now() + 72 * HOUR) });
    await task(ws, b, repB.id, { title: REPLY_TASK_TITLES[0]!, origin: "agent", dueAt: new Date(Date.now() + HOUR) });

    const mine = await api.call(repA, ws, "GET", "/home/summary");
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.replies.count).toBe(1);
    expect(mine.body.replies.top.map((t: JsonBody) => t.contact.id)).toEqual([a]);
    expect(mine.body.calls).toMatchObject({ count: 1 });
    expect(mine.body.calls.top.map((t: JsonBody) => t.title)).toEqual(["Call back"]);
    expect(mine.body.nextSteps.count).toBe(1);
    expect(mine.body.nextSteps.top[0].title).toBe(DECIDE_NEXT_STEP_TITLE);
    expect(mine.body.tasks.overdue).toBe(1);
    expect(mine.body.tasks.overdueTop.map((t: JsonBody) => t.title)).toEqual(["Call back"]);
    // Counts match the lists the cards link to.
    expect((await api.call(repA, ws, "GET", "/tasks/count?ownerId=me&replyTasks=only")).body.count).toBe(1);
    expect(mine.body.team).toBeNull();
    expect(mine.body.flags).toBeNull();

    await pool.query(`insert into public.system_health_alerts (workspace_id, problem, alerted_on) values ($1, 'staff_email_no_mailbox', current_date)`, [ws]);
    const asAdmin = await api.call(admin, ws, "GET", "/home/summary");
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.replies.count).toBe(0); // the admin's own day
    const team = Object.fromEntries(asAdmin.body.team.map((r: JsonBody) => [r.name, [r.openTasks, r.overdue, r.replies]]));
    expect(team["UX3 Rep A"]).toEqual([3, 1, 1]);
    expect(team["UX3 Rep B"]).toEqual([1, 0, 1]);
    expect(asAdmin.body.flags).toContainEqual({ code: "staff_email_no_mailbox", text: expect.stringContaining("no email mailbox") });
  });
});
