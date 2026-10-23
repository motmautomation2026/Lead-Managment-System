/**
 * Feature 3B-2: CRM events → agent wakeups and automatic agent_status changes
 * (onAgentEvent hooks + the migration 026 lifecycle trigger), through the real
 * services and HTTP stack (login check bypassed). Nothing calls OpenAI or sends.
 * Skipped unless TEST_DATABASE_URL is set; uses fresh workspaces per run.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const MIN = 60_000;
const HOUR = 60 * MIN;

describeIfDb("agent events and automatic status changes (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  const authUserIds: string[] = [];
  const workspaceIds: string[] = [];
  let admin: Actor;
  let server: Server;
  let base: string;

  async function newWorkspace(settings: { mode?: "off" | "shadow"; nurture_long_term?: boolean; auto_enroll_new_leads?: boolean } = {}) {
    const id = randomUUID();
    await pool.query(`insert into public.workspaces (id, name, slug) values ($1, $2, $2)`, [id, `agent3b2-${id}`]);
    workspaceIds.push(id);
    await pool.query(
      `update public.agent_settings set mode = $2, nurture_long_term = $3, auto_enroll_new_leads = $4, rep_quiet_hours = 24 where workspace_id = $1`,
      [id, settings.mode ?? "shadow", settings.nurture_long_term ?? false, settings.auto_enroll_new_leads ?? false],
    );
    return id;
  }

  const randomPhone = () => `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  async function newLead(ws: string, phoneE164: string | null = null) {
    const result = await pool.query(
      `insert into public.leads (workspace_id, first_name, company, source, email, phone, phone_e164)
       values ($1, 'Event', 'Event Co', 'referral', $2, $3, $3) returning id`,
      [ws, `agent3b2-${randomUUID()}@example.com`, phoneE164],
    );
    return result.rows[0].id as string;
  }

  async function api(ws: string, method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Workspace-Id": ws },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  /** Enrolled (active) lead whose enroll wakeup is already processed, so the next event starts a fresh pending row. */
  async function activeLead(ws: string, phoneE164: string | null = null) {
    const leadId = await newLead(ws, phoneE164);
    expect((await api(ws, "POST", "/agent/leads/enroll", { leadIds: [leadId] })).body.data[0].result).toBe("enrolled");
    await pool.query(`update public.agent_wakeups set status = 'done', processed_at = now() where lead_id = $1 and status = 'pending'`, [leadId]);
    return leadId;
  }

  const agent = async (leadId: string) =>
    (await pool.query(`select agent_status as status, agent_status_reason as reason from public.leads where id = $1`, [leadId])).rows[0];
  const pending = async (leadId: string) =>
    (await pool.query(`select reason, due_at, payload from public.agent_wakeups where lead_id = $1 and status = 'pending'`, [leadId])).rows;
  const allWakeups = async (leadId: string) => (await pool.query(`select status from public.agent_wakeups where lead_id = $1`, [leadId])).rows;
  const agentTimeline = async (leadId: string) =>
    (
      await pool.query(
        `select title, detail, actor_name, actor_source from public.timeline_events where lead_id = $1 and title like 'AI Agent%' order by occurred_at, created_at`,
        [leadId],
      )
    ).rows;

  /** Exactly one pending wakeup with this reason, due ≈ now + delayMs. */
  async function expectOneWakeup(leadId: string, reason: string, delayMs: number, before: number) {
    const rows = await pending(leadId);
    expect(rows, `pending wakeups for ${reason}`).toHaveLength(1);
    expect(rows[0].reason).toBe(reason);
    expect(rows[0].due_at.getTime()).toBeGreaterThanOrEqual(before + delayMs - 5_000);
    expect(rows[0].due_at.getTime()).toBeLessThanOrEqual(Date.now() + delayMs + 5_000);
    return rows[0];
  }

  async function services() {
    const meetings = await import("../../src/services/meetings.service.js");
    const proposals = await import("../../src/services/proposals.service.js");
    const { withTransaction } = await import("../../src/db.js");
    return { ...meetings, ...proposals, withTransaction };
  }

  async function bookMeeting(ws: string, leadId: string, at = "2030-01-03T04:30:00.000Z") {
    const s = await services();
    return s.withTransaction((c) => s.scheduleMeeting(c, admin, ws, { leadId, title: "Discovery", at, durationMin: 30 }));
  }

  async function inboundWhatsApp(ws: string, phoneE164: string) {
    const { processInboundUpsert } = await import("../../src/services/whatsapp-inbound.service.js");
    await processInboundUpsert(ws, {
      type: "notify",
      messages: [
        {
          key: { id: `agent3b2-${randomUUID()}`, remoteJid: `${phoneE164.slice(1)}@s.whatsapp.net`, fromMe: false },
          message: { conversation: "hello" },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    } as never);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`agent3b2-${randomUUID()}@example.com`]);
    authUserIds.push(auth.rows[0].id);
    const profile = await pool.query(`update public.profiles set role = 'admin', is_active = true, full_name = 'Agent3B2 Admin' where id = $1 returning id, full_name, email`, [
      auth.rows[0].id,
    ]);
    admin = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "admin" };

    const { createApp } = await import("../../src/app.js");
    const app = express();
    app.use((req, _res, next) => {
      req.actor = admin;
      next();
    });
    app.use(createApp());
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const id of workspaceIds) {
      await pool.query(`delete from public.workspaces where id = $1`, [id]).catch((error: Error) => console.warn(`[agentEvents] workspace ${id} not deleted: ${error.message}`));
    }
    for (const id of authUserIds) {
      await pool.query(`delete from auth.users where id = $1`, [id]).catch((error: Error) => console.warn(`[agentEvents] test user ${id} not deleted: ${error.message}`));
    }
    await pool.end();
  });

  it("call logged and note added each queue one wakeup after rep_quiet_hours, merging into one pending row", async () => {
    const ws = await newWorkspace();
    const leadId = await activeLead(ws);
    const before = Date.now();
    expect((await api(ws, "POST", `/leads/${leadId}/calls`, { connected: false, notConnectedReason: "no_answer" })).status).toBe(201);
    await expectOneWakeup(leadId, "call_logged", 24 * HOUR, before);

    expect((await api(ws, "POST", `/leads/${leadId}/notes`, { body: "Spoke to the PA" })).status).toBe(201);
    const merged = await expectOneWakeup(leadId, "call_logged", 24 * HOUR, before);
    expect(merged.payload.events.map((e: { reason: string }) => e.reason)).toEqual(["call_logged", "note_added"]);
    expect(merged.payload.events[1].body).toBeUndefined();

    const noteOnly = await activeLead(ws);
    const t = Date.now();
    await api(ws, "POST", `/leads/${noteOnly}/notes`, { body: "Left a voicemail" });
    await expectOneWakeup(noteOnly, "note_added", 24 * HOUR, t);
  });

  it("proposal status and meeting reschedule wake after 10 minutes", async () => {
    const ws = await newWorkspace();
    const s = await services();
    const leadId = await activeLead(ws);
    const proposal = await s.withTransaction((c) => s.createProposal(c, admin, ws, { leadId, title: "Proposal", emailSendStatus: "skipped", whatsappSendStatus: "skipped" }));
    await pool.query(`update public.agent_wakeups set status = 'done' where lead_id = $1 and status = 'pending'`, [leadId]);
    const before = Date.now();
    expect((await api(ws, "POST", `/proposals/${proposal.id}/status`, { status: "sent" })).status).toBe(200);
    await expectOneWakeup(leadId, "proposal_status", 10 * MIN, before);

    // A booked meeting pauses the lead; an admin resume makes it active again, so the reschedule can wake it.
    const other = await activeLead(ws);
    const meeting = await bookMeeting(ws, other);
    await api(ws, "POST", `/agent/leads/${other}/resume`);
    await pool.query(`update public.agent_wakeups set status = 'done' where lead_id = $1 and status = 'pending'`, [other]);
    const t = Date.now();
    expect((await api(ws, "PATCH", `/meetings/${meeting.id}`, { at: "2030-01-04T04:30:00.000Z" })).status).toBe(200);
    await expectOneWakeup(other, "meeting_rescheduled", 10 * MIN, t);
  });

  it("meeting booked → paused (wakeups cancelled); outcome → active + meeting_outcome wakeup; an admin-paused lead stays paused", async () => {
    const ws = await newWorkspace();
    const s = await services();
    const leadId = await activeLead(ws);
    await api(ws, "POST", `/agent/leads/${leadId}/wake`);
    const meeting = await bookMeeting(ws, leadId);
    expect(await agent(leadId)).toEqual({ status: "paused", reason: "meeting_booked" });
    expect(await pending(leadId)).toEqual([]);

    const before = Date.now();
    await s.withTransaction((c) => s.recordMeetingOutcome(c, admin, ws, meeting.id, "follow_up_required"));
    expect(await agent(leadId)).toEqual({ status: "active", reason: "meeting_done" });
    await expectOneWakeup(leadId, "meeting_outcome", 24 * HOUR, before);
    expect((await agentTimeline(leadId)).map((r) => r.title)).toEqual(["AI Agent Enrolled", "AI Agent Paused", "AI Agent Resumed"]);
    expect((await agentTimeline(leadId))[1]).toMatchObject({ actor_name: "AI Agent", actor_source: "automation" });

    const adminPaused = await activeLead(ws);
    await api(ws, "POST", `/agent/leads/${adminPaused}/pause`);
    const m2 = await bookMeeting(ws, adminPaused);
    await s.withTransaction((c) => s.recordMeetingOutcome(c, admin, ws, m2.id, "follow_up_required"));
    expect(await agent(adminPaused)).toEqual({ status: "paused", reason: "admin_pause" });
    expect(await pending(adminPaused)).toEqual([]);
  });

  it("meeting cancelled: resumes with no other upcoming meeting, stays paused with one", async () => {
    const ws = await newWorkspace();
    const single = await activeLead(ws);
    const m = await bookMeeting(ws, single);
    const before = Date.now();
    expect((await api(ws, "PATCH", `/meetings/${m.id}`, { status: "cancelled" })).status).toBe(200);
    expect(await agent(single)).toEqual({ status: "active", reason: "meeting_done" });
    await expectOneWakeup(single, "meeting_cancelled", 10 * MIN, before);

    const two = await activeLead(ws);
    const first = await bookMeeting(ws, two, "2030-01-03T04:30:00.000Z");
    await bookMeeting(ws, two, "2030-01-10T04:30:00.000Z");
    await api(ws, "PATCH", `/meetings/${first.id}`, { status: "cancelled" });
    expect(await agent(two)).toEqual({ status: "paused", reason: "meeting_booked" });
    expect(await pending(two)).toEqual([]);
  });

  it("inbound WhatsApp → handed_off with wakeups cancelled", async () => {
    const ws = await newWorkspace();
    const phone = randomPhone();
    const leadId = await activeLead(ws, phone);
    await api(ws, "POST", `/agent/leads/${leadId}/wake`);
    expect(await pending(leadId)).toHaveLength(1);
    await inboundWhatsApp(ws, phone);
    expect(await agent(leadId)).toEqual({ status: "handed_off", reason: "lead_replied" });
    expect(await pending(leadId)).toEqual([]);
    expect((await agentTimeline(leadId)).at(-1)).toMatchObject({ title: "AI Agent Handed Off", actor_name: "AI Agent" });
  });

  it("mode off: events create no wakeups and change no status", async () => {
    const ws = await newWorkspace({ mode: "off" });
    const phone = randomPhone();
    const leadId = await newLead(ws, phone);
    await api(ws, "POST", "/agent/leads/enroll", { leadIds: [leadId] });
    await api(ws, "POST", `/leads/${leadId}/notes`, { body: "note" });
    await api(ws, "POST", `/leads/${leadId}/calls`, { connected: false, notConnectedReason: "busy" });
    await bookMeeting(ws, leadId);
    expect(await agent(leadId)).toEqual({ status: "active", reason: "admin_enroll" });
    await inboundWhatsApp(ws, phone);
    expect(await agent(leadId)).toEqual({ status: "active", reason: "admin_enroll" });
    expect(await allWakeups(leadId)).toEqual([]);
  });

  it("won / lost / DNC / merged stop the agent, cancel wakeups and write a timeline row; DNC reactivation leaves it stopped", async () => {
    const ws = await newWorkspace();
    const target = await newLead(ws);
    const cases: [string, (id: string) => Promise<{ status: number }>, string][] = [
      ["won", (id) => api(ws, "POST", `/leads/${id}/won`, {}), "won"],
      ["lost", (id) => api(ws, "POST", `/leads/${id}/lost`, { lossReason: "price_budget" }), "lost"],
      ["dnc", (id) => api(ws, "POST", `/leads/${id}/dnc`, { reason: "Asked us" }), "do_not_contact"],
      ["merged", (id) => api(ws, "POST", `/leads/${id}/merge`, { targetLeadId: target }), "merged"],
    ];
    for (const [name, act, lifecycle] of cases) {
      const leadId = await activeLead(ws);
      await api(ws, "POST", `/agent/leads/${leadId}/wake`);
      expect((await act(leadId)).status, name).toBe(200);
      expect(await agent(leadId), name).toEqual({ status: "stopped", reason: "lifecycle_changed" });
      expect(await pending(leadId), name).toEqual([]);
      expect((await agentTimeline(leadId)).at(-1), name).toEqual({ title: "AI Agent Stopped", detail: lifecycle, actor_name: "AI Agent", actor_source: "automation" });

      if (name === "dnc") {
        expect((await api(ws, "POST", `/leads/${leadId}/dnc/reactivate`, { reason: "They called back" })).status).toBe(200);
        expect(await agent(leadId)).toEqual({ status: "stopped", reason: "lifecycle_changed" });
        expect(await allWakeups(leadId)).not.toContainEqual({ status: "pending" });
      }
    }
  });

  it("long-term nurture stops the agent unless the workspace nurtures long-term", async () => {
    const off = await newWorkspace();
    const a = await activeLead(off);
    expect((await api(off, "POST", `/leads/${a}/long-term-nurture`, {})).status).toBe(200);
    expect(await agent(a)).toEqual({ status: "stopped", reason: "lifecycle_changed" });

    const on = await newWorkspace({ nurture_long_term: true });
    const b = await activeLead(on);
    await api(on, "POST", `/leads/${b}/long-term-nurture`, {});
    expect(await agent(b)).toEqual({ status: "active", reason: "admin_enroll" });
  });

  it("auto-enroll on: manual, CSV and website leads become active with a lead_created wakeup; off: they stay none", async () => {
    const { ingestWebsiteLead } = await import("../../src/services/leadIngest.service.js");
    const { withTransaction } = await import("../../src/db.js");
    const createThree = async (ws: string) => {
      const manual = await api(ws, "POST", "/leads", { firstName: "Auto", company: "Auto Co", source: "referral", email: `agent3b2-${randomUUID()}@example.com` });
      expect(manual.status).toBe(201);
      const csv = await api(ws, "POST", "/leads/import", {
        rows: [{ rowNumber: 1, firstName: "Csv", company: "Csv Co", source: "referral", email: `agent3b2-${randomUUID()}@example.com` }],
      });
      expect(csv.status).toBe(201);
      const web = await withTransaction((c) =>
        ingestWebsiteLead(c, ws, { name: "Web Lead", email: `agent3b2-${randomUUID()}@example.com`, phone: "", company: "Web Co", message: "Hi" }),
      );
      expect(web.status).toBe("created");
      return [manual.body.id as string, csv.body.data.created[0].id as string, (web as { leadId: string }).leadId];
    };

    const on = await newWorkspace({ auto_enroll_new_leads: true });
    const before = Date.now();
    for (const leadId of await createThree(on)) {
      expect(await agent(leadId)).toEqual({ status: "active", reason: "auto_enroll" });
      await expectOneWakeup(leadId, "lead_created", 5 * MIN, before);
      expect((await agentTimeline(leadId))[0]).toMatchObject({ title: "AI Agent Enrolled", actor_name: "AI Agent" });
    }

    const offFlag = await newWorkspace({ auto_enroll_new_leads: false });
    const offMode = await newWorkspace({ mode: "off", auto_enroll_new_leads: true });
    for (const ws of [offFlag, offMode]) {
      for (const leadId of await createThree(ws)) {
        expect(await agent(leadId)).toEqual({ status: "none", reason: null });
        expect(await allWakeups(leadId)).toEqual([]);
      }
    }
  });

  it("a failure inside onAgentEvent doesn't fail call logging", async () => {
    const ws = await newWorkspace();
    const leadId = await activeLead(ws);
    const fn = `agent3b2_fail_${leadId.replace(/-/g, "")}`;
    // Forces a real DB error inside the hook (the wakeup insert) for this lead only.
    await pool.query(
      `create function public.${fn}() returns trigger language plpgsql as $$
       begin if new.lead_id = '${leadId}' then raise exception 'forced agent failure'; end if; return new; end $$`,
    );
    await pool.query(`create trigger ${fn} before insert on public.agent_wakeups for each row execute function public.${fn}()`);
    try {
      const res = await api(ws, "POST", `/leads/${leadId}/calls`, { connected: false, notConnectedReason: "no_answer" });
      expect(res.status).toBe(201);
      const calls = await pool.query(`select count(*)::int as n from public.calls where lead_id = $1`, [leadId]);
      expect(calls.rows[0].n).toBe(1);
      expect(await pending(leadId)).toEqual([]);
    } finally {
      await pool.query(`drop trigger if exists ${fn} on public.agent_wakeups`);
      await pool.query(`drop function if exists public.${fn}()`);
    }
  });

  it("agent hooks leave workflow runs and automation_mode alone", async () => {
    const ws = await newWorkspace();
    const { createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const { enrollLeadInWorkflow } = await import("../../src/services/runs.service.js");
    const { withTransaction } = await import("../../src/db.js");
    const leadId = await activeLead(ws);
    const workflow = await withTransaction((c) => createWorkflow(c, admin, ws, { name: `Agent3B2 ${randomUUID()}`, trigger: "manual_enrollment" }));
    await withTransaction((c) => updateDraftSteps(c, ws, workflow.id, 1, [{ order: 0, delayDays: 3, action: "create_call_task", config: "Call", enabled: true }]));
    await withTransaction((c) => publishVersion(c, admin, ws, workflow.id, 1, "keep_existing"));
    await withTransaction((c) => updateWorkflow(c, ws, workflow.id, { status: "active" }));
    await withTransaction((c) => enrollLeadInWorkflow(c, ws, leadId, workflow.id, "agent 3B-2 test"));

    const snapshot = async () => ({
      runs: (await pool.query(`select * from public.workflow_runs where lead_id = $1 order by id`, [leadId])).rows,
      actions: (await pool.query(`select * from public.scheduled_actions where lead_id = $1 order by id`, [leadId])).rows,
      mode: (await pool.query(`select automation_mode from public.leads where id = $1`, [leadId])).rows[0].automation_mode,
    });
    const before = await snapshot();
    expect(before.runs).toHaveLength(1);
    // Events whose CRM side effects don't touch runs themselves, so any change would be the agent's.
    await api(ws, "POST", `/leads/${leadId}/notes`, { body: "note" });
    await api(ws, "POST", `/agent/leads/${leadId}/wake`);
    expect(await pending(leadId)).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
  });
});
