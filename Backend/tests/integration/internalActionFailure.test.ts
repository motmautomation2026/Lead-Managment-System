/**
 * A failing internal workflow action goes through the normal failure path
 * instead of staying 'executing' forever (audit B7). A send whose action an
 * inbound reply cancelled mid-flight is recorded without a Conflict (B37).
 * Skipped unless TEST_DATABASE_URL is set; commits rows in a fresh workspace
 * per run.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestWorkspace, deleteCreatedTestWorkspaces, trackTestMember } from "../helpers/testWorkspaces.js";
import { Pool, type PoolClient } from "pg";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

// Lets a test make createTask fail with a transient (non-validation) error.
const transientFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../src/services/tasks.service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/services/tasks.service.js")>();
  return {
    ...original,
    createTask: (...args: Parameters<typeof original.createTask>) => {
      if (transientFailure.enabled) throw new Error("Connection terminated unexpectedly");
      return original.createTask(...args);
    },
  };
});

describeIfDb("internal action failures (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let actor: Actor;
  let authUserId: string | undefined;
  let WORKSPACE_ID: string;

  async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

  /** Enrolls a fresh lead in a one-step workflow and claims its action as the worker would. */
  async function claimedAction(action: "change_lead_stage" | "create_call_task", config: string, phone?: string) {
    const { createLead } = await import("../../src/services/leads.service.js");
    const { createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const { enrollLeadInWorkflow } = await import("../../src/services/runs.service.js");
    const lead = await inTransaction((client) =>
      createLead(client, actor, WORKSPACE_ID, { firstName: "Bea", company: "Bea Pvt Ltd", source: "referral", email: `bea-${randomUUID()}@example.com`, phone }),
    );
    const workflow = await inTransaction((client) => createWorkflow(client, actor, WORKSPACE_ID, { name: `B7 ${randomUUID()}`, trigger: "manual_enrollment" }));
    // delayDays 1 keeps a live staging worker from claiming the action before the test does.
    await inTransaction((client) => updateDraftSteps(client, WORKSPACE_ID, workflow.id, 1, [{ order: 0, delayDays: 1, action, config, enabled: true }]));
    await inTransaction((client) => publishVersion(client, actor, WORKSPACE_ID, workflow.id, 1, "keep_existing"));
    await inTransaction((client) => updateWorkflow(client, WORKSPACE_ID, workflow.id, { status: "active" }));
    const run = await inTransaction((client) => enrollLeadInWorkflow(client, WORKSPACE_ID, lead.id, workflow.id, "B7 test"));
    const claimed = await pool.query<{ id: string }>(
      `update public.scheduled_actions set status = 'executing', last_attempt_at = now() where workflow_run_id = $1 returning id`,
      [run!.id],
    );
    return { leadId: lead.id, runId: run!.id, actionId: claimed.rows[0]!.id };
  }

  async function runInternal(actionId: string) {
    const { runInternalAction } = await import("../../src/services/automation.service.js");
    return inTransaction((client) => runInternalAction(client, actionId));
  }

  async function state(ids: { leadId: string; runId: string; actionId: string }) {
    const action = await pool.query(`select status, attempt_count, last_error, scheduled_for from public.scheduled_actions where id = $1`, [ids.actionId]);
    const run = await pool.query(`select status, last_error from public.workflow_runs where id = $1`, [ids.runId]);
    const events = await pool.query(`select title from public.timeline_events where lead_id = $1`, [ids.leadId]);
    return { action: action.rows[0], run: run.rows[0], titles: events.rows.map((row) => row.title as string) };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`b7-${randomUUID()}@example.com`]);
    authUserId = auth.rows[0].id as string;
    const profile = await pool.query(`select id, full_name, email from public.profiles where id = $1`, [authUserId]);
    await trackTestMember(pool, profile.rows[0].id, "salesperson");
    actor = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "salesperson" };
    WORKSPACE_ID = randomUUID();
    await createTestWorkspace(pool, "b7-test", { id: WORKSPACE_ID });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    if (authUserId) {
      await pool.query(`delete from auth.users where id = $1`, [authUserId]).catch((error) => console.warn("[internalActionFailure] test user cleanup failed:", error));
    }
    await pool.end();
  });

  it.each([
    ["an empty change_lead_stage config (400)", ""],
    ["objection_nurture without an objection type (check violation)", "objection_nurture"],
  ])("fails the action and run on the first attempt for %s", async (_label, config) => {
    const ids = await claimedAction("change_lead_stage", config);
    await runInternal(ids.actionId);

    const { action, run, titles } = await state(ids);
    expect(action).toMatchObject({ status: "failed", attempt_count: 1 });
    expect(action.last_error).toBeTruthy();
    expect(run).toMatchObject({ status: "failed", last_error: action.last_error });
    expect(titles).toContain("Workflow Failed");
  });

  it("retries a transient error with backoff, then fails the run after max_attempts", async () => {
    const ids = await claimedAction("create_call_task", "Call back");
    transientFailure.enabled = true;
    try {
      await runInternal(ids.actionId);
      const first = await state(ids);
      expect(first.action).toMatchObject({ status: "pending", attempt_count: 1, last_error: "Connection terminated unexpectedly" });
      expect(new Date(first.action.scheduled_for).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
      expect(first.run.status).not.toBe("failed");
      expect(first.titles).toContain("Automation Step Failed - Retry Scheduled");

      // Final attempt: reclaim it with only one attempt left.
      await pool.query(
        `update public.scheduled_actions set status = 'executing', last_attempt_at = now(), attempt_count = max_attempts - 1 where id = $1`,
        [ids.actionId],
      );
      await runInternal(ids.actionId);
      const last = await state(ids);
      expect(last.action.status).toBe("failed");
      expect(last.run).toMatchObject({ status: "failed", last_error: "Connection terminated unexpectedly" });
      expect(last.titles).toContain("Workflow Failed");
    } finally {
      transientFailure.enabled = false;
    }
  });

  it("leaves nothing executing after a failure and still completes a healthy action", async () => {
    const failing = await claimedAction("change_lead_stage", "");
    const healthy = await claimedAction("create_call_task", "Call back");
    await runInternal(failing.actionId);
    await runInternal(healthy.actionId);

    const executing = await pool.query(`select count(*)::int as n from public.scheduled_actions where workspace_id = $1 and status = 'executing'`, [WORKSPACE_ID]);
    expect(executing.rows[0].n).toBe(0);
    expect((await state(healthy)).action.status).toBe("completed");
  });

  describe("B37: an inbound reply cancels an action while its send is in flight", () => {
    async function cancelledByReply() {
      const phone = `+9196${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
      const ids = await claimedAction("create_call_task", "Call back", phone);
      // The worker is mid-send of an email for this action.
      await pool.query(`update public.scheduled_actions set action_type = 'send_email' where id = $1`, [ids.actionId]);
      const { processInboundUpsert } = await import("../../src/services/whatsapp-inbound.service.js");
      await processInboundUpsert(WORKSPACE_ID, {
        type: "notify",
        messages: [
          {
            key: { id: `b37-${randomUUID()}`, remoteJid: `${phone.slice(1)}@s.whatsapp.net`, fromMe: false },
            message: { conversation: "stop" },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      } as never);
      expect((await state(ids)).action.status).toBe("cancelled");
      return ids;
    }

    async function record(actionId: string, input: import("../../src/services/automation.service.js").RecordResultInput) {
      const { recordActionResult } = await import("../../src/services/automation.service.js");
      return inTransaction((client) => recordActionResult(client, actionId, input));
    }

    it("a send that succeeded anyway: no Conflict, action stays cancelled, run not restarted, timeline note", async () => {
      const ids = await cancelledByReply();
      await record(ids.actionId, { outcome: "success", providerMessageId: "<b37@test>" });
      const { action, run, titles } = await state(ids);
      expect(action.status).toBe("cancelled");
      expect(run.status).toBe("cancelled");
      expect(titles).toContain("A message was already being sent when the reply arrived");
      expect(titles).not.toContain("Email Sent");
      const note = await pool.query(`select detail, actor_source from public.timeline_events where lead_id = $1 and title like 'A message was already%'`, [ids.leadId]);
      expect(note.rows[0]).toEqual({ detail: "Provider message id: <b37@test>", actor_source: "automation" });
    });

    it.each([
      ["failed", { outcome: "failure", error: "SMTP timeout", retryable: true }],
      ["deferred", { outcome: "deferred", error: "Provider down", retryAt: new Date(Date.now() + 60_000) }],
    ] as const)("a %s send: no retry, no reschedule, no error", async (_label, input) => {
      const ids = await cancelledByReply();
      const before = await state(ids);
      await record(ids.actionId, input);
      const after = await state(ids);
      expect(after.action).toEqual(before.action);
      expect(after.run.status).toBe("cancelled");
      expect(after.titles).toEqual(before.titles);
    });
  });
});
