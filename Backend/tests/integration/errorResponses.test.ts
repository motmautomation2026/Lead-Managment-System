/**
 * Error responses through the real HTTP stack (createApp) against a real
 * database: Postgres errors become clear 4xx (audit B24, B14, B6).
 * Auth is bypassed by setting req.actor before the app (requireAuth then
 * skips the token check); everything after that is the production pipeline.
 * Skipped unless TEST_DATABASE_URL is set; commits rows in a fresh workspace
 * per run.
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

describeIfDb("HTTP error responses (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let actor: Actor;
  let authUserId: string | undefined;
  let WORKSPACE_ID: string;
  let server: Server;
  let base: string;

  /** Calls the API as the test actor in the test workspace; `headers` can override X-Workspace-Id. */
  async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Workspace-Id": WORKSPACE_ID, ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  }

  async function newLead() {
    const res = await api("POST", "/leads", { firstName: "Err", company: "Err Pvt Ltd", source: "referral", email: `err-${randomUUID()}@example.com` });
    expect(res.status).toBe(201);
    return (res.body.data ?? res.body) as { id: string };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`errors-${randomUUID()}@example.com`]);
    authUserId = auth.rows[0].id as string;
    const profile = await pool.query(`select id, full_name, email from public.profiles where id = $1`, [authUserId]);
    actor = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "salesperson" };
    WORKSPACE_ID = randomUUID();
    await createTestWorkspace(pool, "errors-test", { id: WORKSPACE_ID });

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
    if (authUserId) {
      await pool.query(`delete from auth.users where id = $1`, [authUserId]).catch((error) => console.warn("[errorResponses] test user cleanup failed:", error));
    }
    await pool.end();
  });

  it("moving a lead to Objection Nurture without a type is a 400 with the human message", async () => {
    const lead = await newLead();
    const res = await api("PATCH", `/leads/${lead.id}`, { pipelineStage: "objection_nurture" });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: "invalid_input",
      message: "Choose an objection type before moving a lead to Objection Nurture.",
      details: { constraint: "leads_objection_stage_has_type" },
    });
  });

  it("a malformed id is a 400, not a 500", async () => {
    const res = await api("GET", "/leads/not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "invalid_input", message: "Invalid lead id." });
  });

  it("a malformed X-Workspace-Id is a 400", async () => {
    const res = await api("GET", "/leads", undefined, { "X-Workspace-Id": "123" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Invalid workspace id.");
  });

  /** A published, active manual workflow with one enrolled lead. */
  async function workflowWithEnrollment() {
    const { createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const { enrollLeadInWorkflow } = await import("../../src/services/runs.service.js");
    const { withTransaction } = await import("../../src/db.js");
    const lead = await newLead();
    const workflow = await withTransaction((client) => createWorkflow(client, actor, WORKSPACE_ID, { name: `Errors ${randomUUID()}`, trigger: "manual_enrollment" }));
    await withTransaction((client) => updateDraftSteps(client, WORKSPACE_ID, workflow.id, 1, [{ order: 0, delayDays: 3, action: "create_call_task", config: "Call", enabled: true }]));
    await withTransaction((client) => publishVersion(client, actor, WORKSPACE_ID, workflow.id, 1, "keep_existing"));
    await withTransaction((client) => updateWorkflow(client, WORKSPACE_ID, workflow.id, { status: "active" }));
    await withTransaction((client) => enrollLeadInWorkflow(client, WORKSPACE_ID, lead.id, workflow.id, "errors test"));
    return workflow;
  }

  it("?force=false does not force-delete a workflow with enrollments (B14)", async () => {
    const workflow = await workflowWithEnrollment();
    const res = await api("DELETE", `/workflows/${workflow.id}?force=false`);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ reason: "has_enrollment_history", runCount: 1 });
    const still = await pool.query(`select count(*)::int as n from public.workflows where id = $1`, [workflow.id]);
    expect(still.rows[0].n).toBe(1);
  });

  it("an unrecognised boolean is a 400, and ?force=true still force-deletes", async () => {
    const workflow = await workflowWithEnrollment();
    expect((await api("DELETE", `/workflows/${workflow.id}?force=yes`)).status).toBe(400);
    expect((await api("DELETE", `/workflows/${workflow.id}?force=true`)).status).toBe(204);
    const gone = await pool.query(`select count(*)::int as n from public.workflows where id = $1`, [workflow.id]);
    expect(gone.rows[0].n).toBe(0);
  });

  describe("deleting a template (B6)", () => {
    async function emailTemplate() {
      const res = await api("POST", "/templates", { name: `Errors template ${randomUUID()}`, channel: "email", subject: "Hi", body: "<p>Hello</p>" });
      expect(res.status).toBe(201);
      return (res.body.data ?? res.body) as { id: string };
    }

    it("is a 409 naming the workflow when only a previous version uses it", async () => {
      const { createWorkflow, updateDraftSteps, publishVersion, createDraft } = await import("../../src/services/workflows.service.js");
      const { withTransaction } = await import("../../src/db.js");
      const template = await emailTemplate();
      const name = `Superseded ${randomUUID()}`;
      const workflow = await withTransaction((client) => createWorkflow(client, actor, WORKSPACE_ID, { name, trigger: "manual_enrollment" }));
      await withTransaction((client) =>
        updateDraftSteps(client, WORKSPACE_ID, workflow.id, 1, [{ order: 0, delayDays: 0, action: "send_email", templateId: template.id, enabled: true }]),
      );
      await withTransaction((client) => publishVersion(client, actor, WORKSPACE_ID, workflow.id, 1, "keep_existing"));
      // v2 drops the template, so v1 (now "previous") is its only user.
      await withTransaction((client) => createDraft(client, actor, WORKSPACE_ID, workflow.id));
      await withTransaction((client) => updateDraftSteps(client, WORKSPACE_ID, workflow.id, 2, [{ order: 0, delayDays: 0, action: "create_call_task", config: "Call", enabled: true }]));
      await withTransaction((client) => publishVersion(client, actor, WORKSPACE_ID, workflow.id, 2, "keep_existing"));

      const res = await api("DELETE", `/templates/${template.id}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({
        code: "conflict",
        message: `This template is used by workflow "${name}" (a published or older version) and can't be deleted. Deactivate it instead.`,
        details: { workflows: [name] },
      });
      const still = await pool.query(`select count(*)::int as n from public.message_templates where id = $1`, [template.id]);
      expect(still.rows[0].n).toBe(1);
    });

    it("still deletes a template only a draft uses", async () => {
      const { createWorkflow, updateDraftSteps } = await import("../../src/services/workflows.service.js");
      const { withTransaction } = await import("../../src/db.js");
      const template = await emailTemplate();
      const workflow = await withTransaction((client) => createWorkflow(client, actor, WORKSPACE_ID, { name: `Draft only ${randomUUID()}`, trigger: "manual_enrollment" }));
      await withTransaction((client) =>
        updateDraftSteps(client, WORKSPACE_ID, workflow.id, 1, [{ order: 0, delayDays: 0, action: "send_email", templateId: template.id, enabled: true }]),
      );

      expect((await api("DELETE", `/templates/${template.id}`)).status).toBe(204);
    });
  });

  it("an unknown owner is a 400 naming the owner, not a 500", async () => {
    const lead = await newLead();
    const res = await api("PATCH", `/leads/${lead.id}`, { ownerId: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("The selected owner doesn't exist.");
  });
});
