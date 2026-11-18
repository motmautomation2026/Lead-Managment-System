/**
 * E2 Live mode API and workflow exclusion through the real HTTP stack (auth bypassed):
 * the go-live gate, the confirm preview, the live-test mark, workflow runs cancelled when
 * a contact becomes live, autoEnroll skipping live contacts, the 409 on manual enrolment,
 * and the new DTO fields. Nothing is sent. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const AI_MANAGED = "This contact is managed by the AI agent. Stop the AI for this contact first.";

describeIfDb("E2 live mode API (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let admin: Actor;
  let rep: Actor;

  async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function lead(ws: string, opts: { status?: string; marked?: boolean } = {}) {
    const result = await pool.query<{ id: string }>(
      `insert into public.leads (workspace_id, first_name, last_name, company, source, email, owner_id, agent_status, agent_live_test)
       values ($1, 'Asha', 'Rao', 'Acme', 'referral', $2, $3, $4, $5) returning id`,
      [ws, `live-api-${randomUUID()}@example.com`, admin.id, opts.status ?? "active", opts.marked ?? false],
    );
    return result.rows[0]!.id;
  }

  /** An active workflow (trigger `trigger`) with one delayed WhatsApp step. */
  async function workflow(ws: string, trigger = "manual_enrollment") {
    const { createTemplate, createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const template = await tx((c) => createTemplate(c, admin, ws, { name: `E2 ${randomUUID()}`, channel: "whatsapp", body: "Hi" }));
    const wf = await tx((c) => createWorkflow(c, admin, ws, { name: `E2 ${randomUUID()}`, trigger: trigger as "manual_enrollment" }));
    await tx((c) => updateDraftSteps(c, ws, wf.id, 1, [{ order: 0, delayDays: 1, action: "send_whatsapp", templateId: template.id, enabled: true }]));
    await tx((c) => publishVersion(c, admin, ws, wf.id, 1, "keep_existing"));
    await tx((c) => updateWorkflow(c, ws, wf.id, { status: "active" }));
    return wf.id;
  }

  async function enrollRun(ws: string, leadId: string, workflowId: string) {
    const { enrollLeadInWorkflow } = await import("../../src/services/runs.service.js");
    return (await tx((c) => enrollLeadInWorkflow(c, ws, leadId, workflowId, "E2 test")))!.id;
  }

  const runStatus = async (runId: string) => (await pool.query(`select status, cancel_reason from public.workflow_runs where id = $1`, [runId])).rows[0];
  const passGate = (ws: string, leadId: string) =>
    pool.query(
      `insert into public.agent_decisions (workspace_id, lead_id, mode, action, outcome, rating, rated_at)
       select $1, $2, 'shadow', 'wait', 'draft', 'good', now() from generate_series(1, 50)`,
      [ws, leadId],
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    api = await startTestApi(pool, "e2-api");
    admin = await api.newUser("admin", { name: "Govinda Admin" });
    rep = await api.newUser("salesperson", { name: "Rep" });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("only admins change mode, scope or the test mark; everyone reads stats and the AI panel", async () => {
    const ws = await createTestWorkspace(pool, "e2-roles");
    const l = await lead(ws);
    expect((await api.call(rep, ws, "PUT", "/agent/settings", { mode: "live" })).status).toBe(403);
    expect((await api.call(rep, ws, "GET", "/agent/settings/live-preview?scope=all")).status).toBe(403);
    expect((await api.call(rep, ws, "PUT", `/agent/leads/${l}/live-test`, { enabled: true })).status).toBe(403);
    expect((await api.call(rep, ws, "GET", "/agent/stats")).body.live).toMatchObject({ scope: "test_contacts", liveContacts: 0, sentToday: 0, sentThisMonth: 0 });
    expect((await api.call(rep, ws, "GET", `/agent/leads/${l}`)).body).toMatchObject({ liveTest: false, effectiveMode: "off" });
  });

  it("E2b: admins edit banned phrases and word limits (defaults 160/75); every CRM user reads them in stats", async () => {
    const ws = await createTestWorkspace(pool, "e2b-message-rules");
    const before = (await api.call(rep, ws, "GET", "/agent/stats")).body.messageRules;
    expect(before).toMatchObject({ emailMaxWords: 120, whatsappMaxWords: 60, styleExamples: "" });
    expect(before.bannedPhrases).toContain("hope you're doing well");
    expect(before.bannedPhrases).toContain("thanks for connecting");
    expect((await api.call(rep, ws, "PUT", "/agent/settings", { bannedPhrases: ["x"] })).status).toBe(403);
    expect((await api.call(admin, ws, "PUT", "/agent/settings", { emailMaxWords: 501 })).status).toBe(400);
    const saved = await api.call(admin, ws, "PUT", "/agent/settings", { bannedPhrases: [" Today ", "today", "per se"], emailMaxWords: 130, whatsappMaxWords: 55, styleExamples: " Hi Ravi. " });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ bannedPhrases: ["Today", "per se"], emailMaxWords: 130, whatsappMaxWords: 55, styleExamples: "Hi Ravi." });
    expect((await api.call(rep, ws, "GET", "/agent/stats")).body.messageRules).toEqual({ bannedPhrases: ["Today", "per se"], emailMaxWords: 130, whatsappMaxWords: 55, styleExamples: "Hi Ravi." });
    expect((await api.call(admin, ws, "PUT", "/agent/settings", { styleExamples: "x".repeat(6001) })).status).toBe(400);
  });

  it("the gate: pilot / all need it (422 with the numbers); test contacts don't; live_since is set when the pilot is switched on", async () => {
    const ws = await createTestWorkspace(pool, "e2-gate");
    const l = await lead(ws);
    for (const liveScope of ["new_leads", "all"]) {
      const refused = await api.call(admin, ws, "PUT", "/agent/settings", { mode: "live", liveScope });
      expect(refused.status).toBe(422);
      expect(refused.body.error.message).toContain("Rate at least 50 decisions (0 rated so far).");
      expect(refused.body.error.details.readiness).toMatchObject({ ready: false, rated: 0, seriousBad: 0 });
    }
    const preview = await api.call(admin, ws, "GET", "/agent/settings/live-preview?scope=all");
    expect(preview.body).toMatchObject({ scope: "all", allowed: false, readiness: { ready: false } });
    expect((await api.call(admin, ws, "GET", "/agent/settings/live-preview?scope=bogus")).status).toBe(400);

    expect((await api.call(admin, ws, "PUT", "/agent/settings", { mode: "live", liveScope: "test_contacts" })).status).toBe(200);
    await passGate(ws, l);
    const before = Date.now();
    const pilot = await api.call(admin, ws, "PUT", "/agent/settings", { liveScope: "new_leads" });
    expect(pilot.status).toBe(200);
    expect(new Date(pilot.body.liveSince).getTime()).toBeGreaterThanOrEqual(before - 5_000);
    // Already on: changing something else keeps live_since.
    const again = await api.call(admin, ws, "PUT", "/agent/settings", { repQuietHours: 2 });
    expect(again.body.liveSince).toBe(pilot.body.liveSince);
    // REL-1: "new leads" = automated contacts (created since the workspace's go-live cutoff, or switched on); a contact
    // whose automation is switched off runs as shadow.
    const fresh = await lead(ws);
    expect((await api.call(admin, ws, "GET", `/agent/leads/${fresh}`)).body.effectiveMode).toBe("live");
    expect((await api.call(admin, ws, "POST", "/contacts/automation", { enabled: false, ids: [l] })).status).toBe(200);
    expect((await api.call(admin, ws, "GET", `/agent/leads/${l}`)).body.effectiveMode).toBe("shadow");
  });

  it("the confirm preview counts contacts that become live and their workflow runs; switching cancels those runs", async () => {
    const ws = await createTestWorkspace(pool, "e2-preview");
    const wf = await workflow(ws);
    const marked = await lead(ws, { marked: true });
    const unmarked = await lead(ws);
    const notAi = await lead(ws, { status: "none", marked: true });
    const [markedRun, unmarkedRun, notAiRun] = [await enrollRun(ws, marked, wf), await enrollRun(ws, unmarked, wf), await enrollRun(ws, notAi, wf)];

    const preview = await api.call(admin, ws, "GET", "/agent/settings/live-preview?scope=test_contacts");
    expect(preview.body).toMatchObject({ allowed: true, liveContacts: 1, workflowRunsToCancel: 1 });

    const live = await api.call(admin, ws, "PUT", "/agent/settings", { mode: "live", liveScope: "test_contacts" });
    expect(live.body).toMatchObject({ mode: "live", liveContactCount: 1 });
    expect(await runStatus(markedRun)).toEqual({ status: "cancelled", cancel_reason: "Managed by AI agent" });
    expect((await runStatus(unmarkedRun)).status).not.toBe("cancelled");
    expect((await runStatus(notAiRun)).status).not.toBe("cancelled");
    const timeline = (await pool.query(`select title, detail from public.timeline_events where lead_id = $1 and title = 'Workflow Cancelled'`, [marked])).rows;
    expect(timeline).toEqual([{ title: "Workflow Cancelled", detail: "Managed by AI agent" }]);

    // Widening to all (gate passed) takes the unmarked AI contact out too.
    await passGate(ws, marked);
    expect((await api.call(admin, ws, "GET", "/agent/settings/live-preview?scope=all")).body).toMatchObject({ allowed: true, liveContacts: 2, workflowRunsToCancel: 1 });
    await api.call(admin, ws, "PUT", "/agent/settings", { liveScope: "all" });
    expect((await runStatus(unmarkedRun)).status).toBe("cancelled");
    expect((await runStatus(notAiRun)).status).not.toBe("cancelled");
    // Back to shadow cancels nothing more (queued sends are stopped by the re-check).
    expect((await api.call(admin, ws, "PUT", "/agent/settings", { mode: "shadow" })).body.liveContactCount).toBe(0);
  });

  it("the live-test mark: timeline rows, Live in the panel, runs cancelled when marked while live; any lifecycle", async () => {
    const ws = await createTestWorkspace(pool, "e2-mark");
    await api.call(admin, ws, "PUT", "/agent/settings", { mode: "live" });
    const wf = await workflow(ws);
    const l = await lead(ws);
    const run = await enrollRun(ws, l, wf);
    const on = await api.call(admin, ws, "PUT", `/agent/leads/${l}/live-test`, { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ liveTest: true, effectiveMode: "live" });
    expect((await runStatus(run)).status).toBe("cancelled");
    const off = await api.call(admin, ws, "PUT", `/agent/leads/${l}/live-test`, { enabled: false });
    expect(off.body).toMatchObject({ liveTest: false, effectiveMode: "shadow" });
    const titles = (await pool.query<{ title: string }>(`select title from public.timeline_events where lead_id = $1 and title like '%AI live test%' order by created_at`, [l])).rows.map((r) => r.title);
    expect(titles).toEqual(["Marked as AI live test by Govinda Admin", "AI live test removed by Govinda Admin"]);

    const lost = await lead(ws, { status: "none" });
    await pool.query(`update public.leads set lifecycle_state = 'lost', loss_reason = 'other' where id = $1`, [lost]);
    expect((await api.call(admin, ws, "PUT", `/agent/leads/${lost}/live-test`, { enabled: true })).status).toBe(200);
    expect((await api.call(admin, ws, "PUT", `/agent/leads/${randomUUID()}/live-test`, { enabled: true })).status).toBe(404);
    expect((await api.call(admin, ws, "PUT", `/agent/leads/${l}/live-test`, { enabled: "yes" })).status).toBe(400);
  });

  it("a live AI contact can't be enrolled in a workflow: 409 manually, skipped by autoEnroll; enrolling in the AI while live cancels runs", async () => {
    const ws = await createTestWorkspace(pool, "e2-enrol");
    await api.call(admin, ws, "PUT", "/agent/settings", { mode: "live" });
    const wf = await workflow(ws);
    const l = await lead(ws, { marked: true });
    const manual = await api.call(rep, ws, "POST", "/runs", { leadId: l, workflowId: wf });
    expect(manual.status).toBe(409);
    expect(manual.body.error.message).toBe(AI_MANAGED);
    expect((await api.call(rep, ws, "POST", "/runs", { leadId: l })).status).toBe(409);
    const { autoEnroll } = await import("../../src/services/runs.service.js");
    expect(await tx((c) => autoEnroll(c, ws, l, "manual_enrollment", "test"))).toEqual([]);

    // A shadow (unmarked) AI contact can still be enrolled.
    const shadow = await lead(ws);
    expect((await api.call(rep, ws, "POST", "/runs", { leadId: shadow, workflowId: wf })).status).toBe(201);

    // Admin enrolment of a marked contact that was in a workflow.
    const marked = await lead(ws, { status: "none", marked: true });
    const run = await enrollRun(ws, marked, wf);
    const enrolled = await api.call(admin, ws, "POST", "/agent/leads/enroll", { leadIds: [marked] });
    expect(enrolled.body.data).toEqual([{ leadId: marked, result: "enrolled" }]);
    expect(await runStatus(run)).toEqual({ status: "cancelled", cancel_reason: "Managed by AI agent" });
  });

  it("auto-enrolled into the AI while live (scope all): the lead_created workflow run is cancelled", async () => {
    const ws = await createTestWorkspace(pool, "e2-auto");
    const seed = await lead(ws);
    await passGate(ws, seed);
    await api.call(admin, ws, "PUT", "/agent/settings", { mode: "live", liveScope: "all", autoEnrollNewLeads: true });
    await workflow(ws, "lead_created");
    const created = await api.call(admin, ws, "POST", "/leads", { firstName: "Nia", company: "Nia Co", source: "referral", email: `nia-${randomUUID()}@example.com` });
    expect(created.status).toBe(201);
    const id = created.body.id ?? created.body.data?.id;
    expect((await pool.query(`select agent_status from public.leads where id = $1`, [id])).rows[0].agent_status).toBe("active");
    const runs = (await pool.query(`select status, cancel_reason from public.workflow_runs where lead_id = $1`, [id])).rows;
    expect(runs).toEqual([{ status: "cancelled", cancel_reason: "Managed by AI agent" }]);
  });

  it("decision DTOs carry the send state and channel", async () => {
    const ws = await createTestWorkspace(pool, "e2-dto");
    const l = await lead(ws, { marked: true });
    const id = (
      await pool.query<{ id: string }>(
        `insert into public.agent_decisions (workspace_id, lead_id, mode, action, reasoning, message_body, outcome, send_status, cancel_reason)
         values ($1, $2, 'live', 'send_whatsapp', 'r', 'Hi', 'executed', 'cancelled', 'The contact replied after this message was written.') returning id`,
        [ws, l],
      )
    ).rows[0]!.id;
    const expected = { sendStatus: "cancelled", cancelReason: "The contact replied after this message was written.", channel: "whatsapp", sentAt: null, sendError: null };
    expect((await api.call(rep, ws, "GET", "/agent/decisions")).body.data[0]).toMatchObject({ id, mode: "live", ...expected });
    expect((await api.call(rep, ws, "GET", `/agent/decisions/${id}`)).body).toMatchObject(expected);
    expect((await api.call(rep, ws, "GET", `/agent/leads/${l}`)).body.decisions[0]).toMatchObject(expected);
  });
});
