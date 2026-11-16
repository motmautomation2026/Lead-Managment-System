/**
 * LL-1 rule 5 direct fixes. WRITTEN IN LL-1, NOT RUN THERE (staging was down): INT-1 runs it. Nothing is
 * sent and nothing calls OpenAI. Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("LL-1 direct fixes (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let owner: Actor;
  let admin: Actor;
  let gone: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "ll1-fixes");
    owner = await api.newUser("salesperson", { name: "LL1 Fix Owner" });
    admin = await api.newUser("admin", { name: "LL1 Fix Admin" });
    gone = await api.newUser("salesperson", { name: "LL1 Gone", isActive: false });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  const randomPhone = () => `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  async function lead(ws: string, over: { ownerId?: string | null; agentStatus?: string; phone?: string } = {}) {
    const phone = over.phone ?? randomPhone();
    return (
      await pool.query<{ id: string }>(
        `insert into public.leads (workspace_id, first_name, last_name, company, source, email, phone, phone_e164, owner_id, agent_status)
         values ($1, 'Ravi', 'Iyer', 'Acme', 'referral', $2, $3, $3, $4, $5) returning id`,
        [ws, `ll1f-${randomUUID()}@example.com`, phone, over.ownerId === undefined ? owner.id : over.ownerId, over.agentStatus ?? "none"],
      )
    ).rows[0]!.id;
  }
  const tx = async <T>(fn: (db: import("pg").PoolClient) => Promise<T>) => (await import("../../src/db.js")).withTransaction(fn);
  const openTasks = async (leadId: string) =>
    (await pool.query(`select title, task_type, owner_id, origin from public.tasks where lead_id = $1 and status = 'open' order by created_at`, [leadId])).rows;
  const bellsFor = async (leadId: string) => (await pool.query(`select recipient_id, title from public.notifications where lead_id = $1 order by created_at`, [leadId])).rows;

  async function whatsappReply(ws: string, phone: string, text: string) {
    const { processInboundUpsert } = await import("../../src/services/whatsapp-inbound.service.js");
    await processInboundUpsert(ws, {
      type: "notify",
      messages: [{ key: { id: `ll1-${randomUUID()}`, remoteJid: `${phone.slice(1)}@s.whatsapp.net`, fromMe: false }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) }],
    } as never);
  }

  it("reply on a manual (non-AI) lead → reply task for the owner + owner bell", async () => {
    const ws = await createTestWorkspace(pool, "ll1-fixes");
    const phone = randomPhone();
    const id = await lead(ws, { phone });
    await whatsappReply(ws, phone, "Who is this?");
    expect(await openTasks(id)).toEqual([{ title: "Lead replied on WhatsApp — respond today", task_type: "follow_up", owner_id: owner.id, origin: "agent" }]);
    expect((await bellsFor(id)).map((b) => b.recipient_id)).toEqual([owner.id]);
  });

  it("reply on an unassigned lead → unowned reply task + the admins' bell; the 2-hour escalation then fires", async () => {
    const ws = await createTestWorkspace(pool, "ll1-fixes");
    const phone = randomPhone();
    const id = await lead(ws, { ownerId: null, phone });
    await whatsappReply(ws, phone, "Hello");
    expect(await openTasks(id)).toMatchObject([{ owner_id: null, title: "Lead replied on WhatsApp — respond today" }]);
    expect((await bellsFor(id)).map((b) => b.recipient_id)).toEqual([admin.id]);
    await pool.query(`update public.tasks set created_at = now() - interval '3 days' where lead_id = $1`, [id]);
    await pool.query(`update public.agent_settings set reminders_since = now() - interval '4 days' where workspace_id = $1`, [ws]);
    const { runReplyEscalation } = await import("../../src/services/workReminders.service.js");
    expect(await runReplyEscalation({ workspaceIds: [ws] })).toHaveLength(1);
    expect((await bellsFor(id)).map((b) => b.title)).toContain("Nobody has answered Ravi Iyer's reply yet (2 h, no owner)");
  });

  it("reply on a lead whose owner was deactivated → unowned task, admins' bell", async () => {
    const ws = await createTestWorkspace(pool, "ll1-fixes");
    const phone = randomPhone();
    const id = await lead(ws, { ownerId: gone.id, phone });
    await whatsappReply(ws, phone, "Hi");
    expect(await openTasks(id)).toMatchObject([{ owner_id: null }]);
    expect((await bellsFor(id)).map((b) => b.recipient_id)).toEqual([admin.id]);
  });

  it("AI stop no_response → long-term nurture + 'AI journey ended without a reply — decide next step' + bell", async () => {
    const ws = await createTestWorkspace(pool, "ll1-fixes");
    const id = await lead(ws, { agentStatus: "active" });
    const { executeStop } = await import("../../src/services/agentSends.service.js");
    await tx((db) => executeStop(db, ws, id, randomUUID(), "no_response"));
    const row = (await pool.query(`select lifecycle_state, agent_status from public.leads where id = $1`, [id])).rows[0];
    expect(row).toEqual({ lifecycle_state: "long_term_nurture", agent_status: "stopped" });
    expect(await openTasks(id)).toMatchObject([{ title: "AI journey ended without a reply — decide next step", owner_id: owner.id, origin: "agent" }]);
    expect((await bellsFor(id)).map((b) => b.recipient_id)).toEqual([owner.id]);
  });

  it("AI stop on a DNC lead → no task", async () => {
    const ws = await createTestWorkspace(pool, "ll1-fixes");
    const id = await lead(ws, { agentStatus: "active" });
    await pool.query(`update public.leads set lifecycle_state = 'do_not_contact', dnc_reason = 'test', dnc_at = now() where id = $1`, [id]);
    const { executeStop } = await import("../../src/services/agentSends.service.js");
    await tx((db) => executeStop(db, ws, id, randomUUID(), "not_a_fit"));
    expect(await openTasks(id)).toEqual([]);
  });

  it("AI handoff on an unassigned lead → unowned handoff task + the admins' bell", async () => {
    const ws = await createTestWorkspace(pool, "ll1-fixes");
    const id = await lead(ws, { ownerId: null, agentStatus: "active" });
    const { executeHandoff } = await import("../../src/services/agentSends.service.js");
    await tx((db) => executeHandoff(db, ws, id, randomUUID(), "Asked for a price"));
    expect(await openTasks(id)).toMatchObject([{ title: "AI handed off — please follow up", owner_id: null }]);
    expect((await bellsFor(id)).map((b) => b.recipient_id)).toEqual([admin.id]);
  });

  it("meeting no-show → 'Reschedule the meeting' +1 d for the meeting owner; with another future meeting → none", async () => {
    const ws = await createTestWorkspace(pool, "ll1-fixes");
    const id = await lead(ws);
    const meet = (when: string) =>
      pool.query<{ id: string }>(`insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status) values ($1, $2, $3, 'Intro', now() + $4::interval, 'scheduled') returning id`, [ws, id, owner.id, when]);
    const past = (await meet("-1 hour")).rows[0]!.id;
    const { updateMeeting } = await import("../../src/services/meetings.service.js");
    await tx((db) => updateMeeting(db, owner, ws, past, { status: "no_show" }));
    expect(await openTasks(id)).toMatchObject([{ title: "Reschedule the meeting", task_type: "schedule_meeting", owner_id: owner.id }]);

    const other = await lead(ws);
    const first = (
      await pool.query<{ id: string }>(`insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status) values ($1, $2, $3, 'A', now() + interval '1 day', 'scheduled') returning id`, [ws, other, owner.id])
    ).rows[0]!.id;
    await pool.query(`insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status) values ($1, $2, $3, 'B', now() + interval '3 days', 'scheduled')`, [ws, other, owner.id]);
    await tx((db) => updateMeeting(db, owner, ws, first, { status: "cancelled" }));
    expect((await openTasks(other)).map((t) => t.title)).not.toContain("Reschedule the meeting");
  });

  it("meeting outcome reminder on an unowned meeting + lead → unowned task + the admins' bell (was: skipped)", async () => {
    const ws = await createTestWorkspace(pool, "ll1-fixes");
    const id = await lead(ws, { ownerId: null });
    await pool.query(`update public.agent_settings set reminders_since = now() - interval '10 days' where workspace_id = $1`, [ws]);
    await pool.query(
      `insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status, created_at) values ($1, $2, null, 'Intro', now() - interval '3 days', 'scheduled', now() - interval '5 days')`,
      [ws, id],
    );
    const { runMeetingOutcomeTasks } = await import("../../src/services/workReminders.service.js");
    await runMeetingOutcomeTasks({ workspaceIds: [ws] });
    expect(await openTasks(id)).toMatchObject([{ title: "Log the meeting outcome", owner_id: null }]);
    expect((await bellsFor(id)).map((b) => b.recipient_id)).toEqual([admin.id]);
  });

  it("website lead with the AI off → enrolled in the published lead_created workflow", async () => {
    const ws = await createTestWorkspace(pool, "ll1-fixes");
    const workflow = await pool.query<{ id: string }>(`insert into public.workflows (workspace_id, name, trigger, status) values ($1, $2, 'lead_created', 'active') returning id`, [ws, `LL1 ${randomUUID()}`]);
    const version = await pool.query<{ id: string }>(`insert into public.workflow_versions (workflow_id, version_number, status, published_at) values ($1, 1, 'published', now()) returning id`, [workflow.rows[0]!.id]);
    await pool.query(`insert into public.workflow_steps (workflow_version_id, step_order, delay_days, action, config) values ($1, 0, 1, 'create_call_task', 'Call them')`, [version.rows[0]!.id]);
    const { ingestWebsiteLead } = await import("../../src/services/leadIngest.service.js");
    const outcome = await tx((db) =>
      ingestWebsiteLead(db, ws, { name: "Web Visitor", email: `ll1w-${randomUUID()}@example.com`, phone: randomPhone(), company: "Web Ltd", message: "Hello" } as never),
    );
    const leadId = (outcome as { leadId: string }).leadId;
    const runs = await pool.query(`select workflow_id from public.workflow_runs where lead_id = $1`, [leadId]);
    expect(runs.rows).toEqual([{ workflow_id: workflow.rows[0]!.id }]);
  });
});
