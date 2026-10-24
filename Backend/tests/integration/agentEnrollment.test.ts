/**
 * Feature 3B-1: agent settings, playbook versions and lead enrollment through
 * the real HTTP stack (login check bypassed). Nothing calls OpenAI or sends.
 * Skipped unless TEST_DATABASE_URL is set; uses fresh workspaces per run.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { Pool } from "pg";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("agent settings and enrollment (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  const authUserIds: string[] = [];
  const workspaceIds: string[] = [];
  let admin: Actor;
  let rep: Actor;
  let actor: Actor;
  let server: Server;
  let base: string;

  async function newUser(name: string, role: "admin" | "salesperson"): Promise<Actor> {
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`agent3b-${name}-${randomUUID()}@example.com`]);
    authUserIds.push(auth.rows[0].id);
    const profile = await pool.query(`update public.profiles set role = $2, is_active = true, full_name = $3 where id = $1 returning id, full_name, email`, [
      auth.rows[0].id,
      role,
      `Agent3B ${name}`,
    ]);
    return { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role };
  }

  async function newWorkspace(): Promise<string> {
    const id = randomUUID();
    await createTestWorkspace(pool, "agent3b", { id: id });
    workspaceIds.push(id);
    return id;
  }

  async function newLead(workspaceId: string, extra: { email?: string | null; phone?: string | null; phoneE164?: string | null } = {}) {
    const email = extra.email === undefined ? `agent3b-${randomUUID()}@example.com` : extra.email;
    const result = await pool.query(
      `insert into public.leads (workspace_id, first_name, company, source, email, phone, phone_e164)
       values ($1, 'Agent', 'Agent Co', 'referral', $2, $3, $4) returning id`,
      [workspaceId, email, extra.phone ?? null, extra.phoneE164 ?? null],
    );
    return result.rows[0].id as string;
  }

  async function api(as: Actor, workspaceId: string, method: string, path: string, body?: unknown) {
    actor = as;
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Workspace-Id": workspaceId },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  const setMode = (workspaceId: string, mode: "off" | "shadow") => api(admin, workspaceId, "PUT", "/agent/settings", { mode });

  async function wakeups(leadId: string) {
    return (await pool.query(`select status, reason, payload from public.agent_wakeups where lead_id = $1 order by created_at`, [leadId])).rows;
  }
  const pending = async (leadId: string) => (await wakeups(leadId)).filter((w) => w.status === "pending");
  const agentStatusOf = async (leadId: string) =>
    (await pool.query(`select agent_status, agent_status_reason from public.leads where id = $1`, [leadId])).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    admin = await newUser("admin", "admin");
    rep = await newUser("rep", "salesperson");

    const { createApp } = await import("../../src/app.js");
    const app = express();
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use(createApp());
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const id of authUserIds) {
      await pool.query(`delete from auth.users where id = $1`, [id]).catch((error: Error) => console.warn(`[agentEnrollment] test user ${id} not deleted: ${error.message}`));
    }
    await pool.end();
  });

  it("every /agent route is admin-only: a salesperson gets 403", async () => {
    const ws = await newWorkspace();
    const leadId = await newLead(ws);
    const calls: [string, string, unknown?][] = [
      ["GET", "/agent/settings"],
      ["PUT", "/agent/settings", { mode: "shadow" }],
      ["GET", "/agent/playbooks"],
      ["POST", "/agent/playbooks", { body: "Be helpful." }],
      ["POST", "/agent/playbooks/1/restore"],
      ["POST", "/agent/leads/enroll", { leadIds: [leadId] }],
      ["POST", `/agent/leads/${leadId}/pause`],
      ["POST", `/agent/leads/${leadId}/resume`],
      ["POST", `/agent/leads/${leadId}/stop`, {}],
      ["POST", `/agent/leads/${leadId}/wake`],
    ];
    for (const [method, path, body] of calls) expect((await api(rep, ws, method, path, body)).status, `${method} ${path}`).toBe(403);
    expect(await agentStatusOf(leadId)).toMatchObject({ agent_status: "none" });
  });

  it("settings: read, update, live → 422, invalid → 400 (including a cross-field rule against the saved value)", async () => {
    const ws = await newWorkspace();
    const initial = await api(admin, ws, "GET", "/agent/settings");
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ mode: "off", sendWindowStart: "09:30", sendWindowEnd: "19:00", repQuietHours: 24, autoEnrollNewLeads: false, activeLeadCount: 0 });

    expect(initial.body.companyDisplayName).toBeNull();
    const saved = await api(admin, ws, "PUT", "/agent/settings", { sendWindowStart: "10:00", repQuietHours: 12, monthlyBudgetUsd: 50.5, maxDecisionsPerDay: 20, companyDisplayName: " MOTM Technologies " });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ sendWindowStart: "10:00", repQuietHours: 12, monthlyBudgetUsd: 50.5, maxDecisionsPerDay: 20, companyDisplayName: "MOTM Technologies", updatedBy: admin.id });
    expect((await api(admin, ws, "PUT", "/agent/settings", { companyDisplayName: null })).body.companyDisplayName).toBeNull();

    const live = await api(admin, ws, "PUT", "/agent/settings", { mode: "live" });
    expect(live.status).toBe(422);
    expect(live.body.error.message).toBe("Live mode isn't available yet.");

    for (const bad of [{ minGapHours: 0 }, { sendDays: [] }, { sendDays: [1, 1] }, { emailOptOutText: " " }, { repQuietHours: 169 }, { sendWindowStart: "20:00" }, { wakeMinDays: 40 }]) {
      expect((await api(admin, ws, "PUT", "/agent/settings", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await api(admin, ws, "GET", "/agent/settings")).body).toMatchObject({ mode: "off", sendWindowStart: "10:00", minGapHours: 48 });
  });

  it("playbooks: parallel saves get distinct versions; restore creates a new version with the old body", async () => {
    const ws = await newWorkspace();
    const saves = await Promise.all(["A", "B", "C"].map((body) => api(admin, ws, "POST", "/agent/playbooks", { body: `Playbook ${body}` })));
    expect(saves.map((s) => s.status)).toEqual([201, 201, 201]);
    expect(saves.map((s) => s.body.version).sort()).toEqual([1, 2, 3]);
    expect((await api(admin, ws, "POST", "/agent/playbooks", { body: "  " })).status).toBe(400);

    const v1Body = saves.find((s) => s.body.version === 1)!.body.body;
    const restored = await api(admin, ws, "POST", "/agent/playbooks/1/restore");
    expect(restored.status).toBe(201);
    expect(restored.body).toMatchObject({ version: 4, body: v1Body, createdByName: admin.fullName });
    expect((await api(admin, ws, "POST", "/agent/playbooks/99/restore")).status).toBe(404);

    const list = await api(admin, ws, "GET", "/agent/playbooks");
    expect(list.body.currentVersion).toBe(4);
    expect(list.body.data.map((p: { version: number }) => p.version)).toEqual([4, 3, 2, 1]);
  });

  it("enrolls a mixed batch with a reason per lead; mode off creates no wakeups", async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace();
    const good = await newLead(ws);
    const dnc = await newLead(ws);
    expect((await api(admin, ws, "POST", `/leads/${dnc}/dnc`, { reason: "Asked us" })).status).toBe(200);
    const otherWs = await newLead(other);
    const noContact = await newLead(ws, { email: null, phone: "12", phoneE164: null });
    const already = await newLead(ws);
    expect((await api(admin, ws, "POST", "/agent/leads/enroll", { leadIds: [already] })).body.data).toEqual([{ leadId: already, result: "enrolled" }]);

    const res = await api(admin, ws, "POST", "/agent/leads/enroll", { leadIds: [good, dnc, otherWs, noContact, already] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { leadId: good, result: "enrolled" },
      { leadId: dnc, result: "skipped", reason: "not_eligible" },
      { leadId: otherWs, result: "skipped", reason: "not_found" },
      { leadId: noContact, result: "skipped", reason: "no_contact" },
      { leadId: already, result: "skipped", reason: "already_active" },
    ]);
    expect(await agentStatusOf(good)).toEqual({ agent_status: "active", agent_status_reason: "admin_enroll" });
    expect(await agentStatusOf(otherWs)).toMatchObject({ agent_status: "none" });
    expect(await wakeups(good)).toEqual([]);

    const timeline = await pool.query(`select title, actor_name, actor_source from public.timeline_events where lead_id = $1 and title like 'AI Agent%'`, [good]);
    expect(timeline.rows).toEqual([{ title: "AI Agent Enrolled", actor_name: admin.fullName, actor_source: "manual" }]);

    const lead = await api(rep, ws, "GET", `/leads/${good}`);
    expect(lead.body).toMatchObject({ agentStatus: "active", agentStatusReason: "admin_enroll", agentTouchCount: 0 });
    expect(lead.body.agentStatusChangedAt).toEqual(expect.any(String));

    expect((await api(admin, ws, "POST", "/agent/leads/enroll", { leadIds: ["not-a-uuid"] })).status).toBe(400);
    expect((await api(admin, ws, "POST", "/agent/leads/enroll", { leadIds: [] })).status).toBe(400);
  });

  it("shadow: exactly one pending wakeup per lead after enroll + wakeNow; pause cancels it, resume queues one", async () => {
    const ws = await newWorkspace();
    expect((await setMode(ws, "shadow")).status).toBe(200);
    const leadId = await newLead(ws);

    await api(admin, ws, "POST", "/agent/leads/enroll", { leadIds: [leadId] });
    const wake = await api(admin, ws, "POST", `/agent/leads/${leadId}/wake`);
    expect(wake.body).toEqual({ wakeup: "merged" });
    const [only, ...rest] = await pending(leadId);
    expect(rest).toEqual([]);
    expect(only.reason).toBe("enrolled");
    expect(only.payload.events.map((e: { reason: string }) => e.reason)).toEqual(["enrolled", "manual_wake"]);

    const paused = await api(admin, ws, "POST", `/agent/leads/${leadId}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.agentStatus).toBe("paused");
    expect(await pending(leadId)).toEqual([]);
    expect((await api(admin, ws, "POST", `/agent/leads/${leadId}/pause`)).status).toBe(422);
    expect((await api(admin, ws, "POST", `/agent/leads/${leadId}/wake`)).status).toBe(422);

    expect((await api(admin, ws, "POST", `/agent/leads/${leadId}/resume`)).body.agentStatus).toBe("active");
    const afterResume = await pending(leadId);
    expect(afterResume).toHaveLength(1);
    expect(afterResume[0].reason).toBe("resumed");

    const stopped = await api(admin, ws, "POST", `/agent/leads/${leadId}/stop`, { note: "Rep is handling it" });
    expect(stopped.body).toMatchObject({ agentStatus: "stopped", agentStatusReason: "admin_stop" });
    expect(await pending(leadId)).toEqual([]);
    const note = await pool.query(`select detail from public.timeline_events where lead_id = $1 and title = 'AI Agent Stopped'`, [leadId]);
    expect(note.rows[0].detail).toBe("Rep is handling it");

    expect((await api(admin, ws, "POST", `/agent/leads/${randomUUID()}/pause`)).status).toBe(404);
    expect((await api(admin, ws, "POST", `/agent/leads/not-a-uuid/pause`)).status).toBe(400);
  });

  it("asked_to_stop can never be re-enrolled; admin_stop can", async () => {
    const ws = await newWorkspace();
    const asked = await newLead(ws);
    const adminStopped = await newLead(ws);
    await api(admin, ws, "POST", "/agent/leads/enroll", { leadIds: [asked, adminStopped] });
    // The agent itself records asked_to_stop (3C); simulate it.
    await pool.query(`update public.leads set agent_status = 'stopped', agent_status_reason = 'asked_to_stop' where id = $1`, [asked]);
    await api(admin, ws, "POST", `/agent/leads/${adminStopped}/stop`, {});

    const res = await api(admin, ws, "POST", "/agent/leads/enroll", { leadIds: [asked, adminStopped] });
    expect(res.body.data).toEqual([
      { leadId: asked, result: "skipped", reason: "permanently_stopped" },
      { leadId: adminStopped, result: "enrolled" },
    ]);
  });

  it("off → shadow queues a wakeup (spread over an hour) for active leads only; → off leaves them pending", async () => {
    const ws = await newWorkspace();
    const [a, b, never, paused] = [await newLead(ws), await newLead(ws), await newLead(ws), await newLead(ws)];
    await api(admin, ws, "POST", "/agent/leads/enroll", { leadIds: [a, b, paused] });
    await api(admin, ws, "POST", `/agent/leads/${paused}/pause`);
    expect(await pending(a)).toEqual([]);
    // The Off → Shadow confirm shows this: active only (not the paused or never-enrolled lead).
    expect((await api(admin, ws, "GET", "/agent/settings")).body.activeLeadCount).toBe(2);

    const before = Date.now();
    expect((await setMode(ws, "shadow")).body.mode).toBe("shadow");
    const rows = (
      await pool.query(`select lead_id, reason, payload, due_at from public.agent_wakeups where workspace_id = $1 and status = 'pending'`, [ws])
    ).rows;
    expect(rows.map((r) => r.lead_id).sort()).toEqual([a, b].sort());
    for (const row of rows) {
      expect(row.reason).toBe("resumed");
      expect(row.payload.events[0]).toMatchObject({ reason: "resumed", source: "mode_on" });
      expect(row.due_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
      expect(row.due_at.getTime()).toBeLessThanOrEqual(before + 60 * 60 * 1000);
    }
    expect(await wakeups(never)).toEqual([]);
    expect(await wakeups(paused)).toEqual([]);

    await setMode(ws, "off");
    expect(await pending(a)).toHaveLength(1);
  });

  it("enrolling, pausing and stopping never touch the lead's workflow runs or automation mode", async () => {
    const ws = await newWorkspace();
    await setMode(ws, "shadow");
    const { createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const { enrollLeadInWorkflow } = await import("../../src/services/runs.service.js");
    const { withTransaction } = await import("../../src/db.js");
    const leadId = await newLead(ws);
    const workflow = await withTransaction((c) => createWorkflow(c, admin, ws, { name: `Agent3B ${randomUUID()}`, trigger: "manual_enrollment" }));
    await withTransaction((c) => updateDraftSteps(c, ws, workflow.id, 1, [{ order: 0, delayDays: 3, action: "create_call_task", config: "Call", enabled: true }]));
    await withTransaction((c) => publishVersion(c, admin, ws, workflow.id, 1, "keep_existing"));
    await withTransaction((c) => updateWorkflow(c, ws, workflow.id, { status: "active" }));
    await withTransaction((c) => enrollLeadInWorkflow(c, ws, leadId, workflow.id, "agent 3B test"));

    const snapshot = async () => ({
      runs: (await pool.query(`select * from public.workflow_runs where lead_id = $1 order by id`, [leadId])).rows,
      actions: (await pool.query(`select * from public.scheduled_actions where lead_id = $1 order by id`, [leadId])).rows,
      mode: (await pool.query(`select automation_mode from public.leads where id = $1`, [leadId])).rows[0].automation_mode,
    });
    const before = await snapshot();
    expect(before.runs).toHaveLength(1);

    await api(admin, ws, "POST", "/agent/leads/enroll", { leadIds: [leadId] });
    await api(admin, ws, "POST", `/agent/leads/${leadId}/wake`);
    await api(admin, ws, "POST", `/agent/leads/${leadId}/pause`);
    await api(admin, ws, "POST", `/agent/leads/${leadId}/resume`);
    await api(admin, ws, "POST", `/agent/leads/${leadId}/stop`, {});
    expect(await snapshot()).toEqual(before);
  });
});
