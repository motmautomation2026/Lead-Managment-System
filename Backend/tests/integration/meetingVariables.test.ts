/**
 * {{meeting.*}} variables are only allowed in send steps of meeting-triggered
 * workflows, checked at publish and at template edit.
 * Skipped unless TEST_DATABASE_URL is set; commits rows in a fresh workspace
 * per run.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import type { Actor } from "../../src/authMiddleware.js";
import type { WorkflowTrigger } from "../../src/domain/enums.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("meeting variables need a meeting trigger (requires TEST_DATABASE_URL)", () => {
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

  async function template(name: string, body: string) {
    const { createTemplate } = await import("../../src/services/workflows.service.js");
    return inTransaction((client) => createTemplate(client, actor, WORKSPACE_ID, { name, channel: "email", subject: "Hello", body }));
  }

  /** A workflow whose draft v1 has a call task (step 1) then an email send with the template (step 2). */
  async function draftWorkflow(trigger: WorkflowTrigger, templateId: string) {
    const { createWorkflow, updateDraftSteps } = await import("../../src/services/workflows.service.js");
    const workflow = await inTransaction((client) => createWorkflow(client, actor, WORKSPACE_ID, { name: `Meeting vars ${trigger} ${randomUUID()}`, trigger }));
    await inTransaction((client) =>
      updateDraftSteps(client, WORKSPACE_ID, workflow.id, 1, [
        { order: 0, delayDays: 0, action: "create_call_task", config: "Call", enabled: true },
        { order: 1, delayDays: 1, action: "send_email", templateId, enabled: true },
      ]),
    );
    return workflow;
  }

  async function publish(workflowId: string) {
    const { publishVersion } = await import("../../src/services/workflows.service.js");
    return inTransaction((client) => publishVersion(client, actor, WORKSPACE_ID, workflowId, 1, "keep_existing"));
  }

  async function updateTemplate(id: string, patch: { name?: string; subject?: string; body?: string }) {
    const { updateTemplate } = await import("../../src/services/workflows.service.js");
    return inTransaction((client) => updateTemplate(client, WORKSPACE_ID, id, patch));
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`meeting-vars-${randomUUID()}@example.com`]);
    authUserId = auth.rows[0].id as string;
    const profile = await pool.query(`select id, full_name, email from public.profiles where id = $1`, [authUserId]);
    actor = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "salesperson" };
    WORKSPACE_ID = randomUUID();
    await pool.query(`insert into public.workspaces (id, name, slug) values ($1, $2, $2)`, [WORKSPACE_ID, `meeting-vars-test-${WORKSPACE_ID}`]);
  });

  afterAll(async () => {
    if (authUserId) {
      await pool.query(`delete from auth.users where id = $1`, [authUserId]).catch((error) => console.warn("[meetingVariables] test user cleanup failed:", error));
    }
    await pool.end();
  });

  describe("publishVersion", () => {
    it("rejects a non-meeting trigger whose send step uses meeting variables, naming the step and template", async () => {
      const meetingTemplate = await template("Meeting reminder", "<p>See you on {{meeting.date}} at {{meeting.time}}</p>");
      const workflow = await draftWorkflow("lead_created", meetingTemplate.id);

      const error = await publish(workflow.id).catch((e: unknown) => e);

      expect(error).toMatchObject({ status: 400 });
      expect((error as Error).message).toContain('Step 2 template "Meeting reminder" uses {{meeting.date}}, {{meeting.time}}');
      expect((error as Error).message).toContain('"lead_created" trigger has no meeting');
      const version = await pool.query(`select status from public.workflow_versions where workflow_id = $1 and version_number = 1`, [workflow.id]);
      expect(version.rows[0].status).toBe("draft");
    });

    it.each(["meeting_scheduled", "meeting_agreed", "meeting_highly_interested", "meeting_proposal_requested", "meeting_needs_more_information", "meeting_not_ready", "meeting_not_a_fit"] as const)(
      "publishes a %s workflow that uses meeting variables",
      async (trigger) => {
        const meetingTemplate = await template(`Meeting ${trigger}`, "<p>Joining link: {{meeting.link}}</p>");
        const workflow = await draftWorkflow(trigger, meetingTemplate.id);
        const published = await publish(workflow.id);
        expect(published.versions.find((version) => version.version === 1)?.status).toBe("published");
      },
    );

    it("still publishes a non-meeting trigger whose templates use only lead variables", async () => {
      const leadTemplate = await template("Lead hello", "<p>Hi {{lead.firstName}}</p>");
      const workflow = await draftWorkflow("lead_created", leadTemplate.id);
      await expect(publish(workflow.id)).resolves.toBeTruthy();
    });
  });

  describe("updateTemplate", () => {
    it("rejects adding meeting variables to a template used by a published non-meeting workflow", async () => {
      const shared = await template("Shared follow-up", "<p>Hi {{lead.firstName}}</p>");
      const workflow = await draftWorkflow("call_not_connected", shared.id);
      await publish(workflow.id);

      const error = await updateTemplate(shared.id, { body: "<p>Hi {{lead.firstName}}, see you {{meeting.date}}</p>" }).catch((e: unknown) => e);

      expect(error).toMatchObject({ status: 400 });
      expect((error as Error).message).toContain('Template "Shared follow-up" cannot use {{meeting.date}}');
      expect((error as Error).message).toContain(`"${workflow.name}" step 2 (trigger "call_not_connected")`);
      const row = await pool.query(`select body from public.message_templates where id = $1`, [shared.id]);
      expect(row.rows[0].body).not.toContain("meeting.date");
    });

    it("rejects meeting variables in the subject too", async () => {
      const shared = await template("Shared subject", "<p>Hi</p>");
      await publish((await draftWorkflow("lead_created", shared.id)).id);
      await expect(updateTemplate(shared.id, { subject: "Your meeting on {{meeting.date}}" })).rejects.toMatchObject({ status: 400 });
    });

    it("allows meeting variables when only meeting-triggered or draft workflows use the template", async () => {
      const meetingOnly = await template("Meeting-only", "<p>Hi</p>");
      await publish((await draftWorkflow("meeting_scheduled", meetingOnly.id)).id);
      await draftWorkflow("lead_created", meetingOnly.id); // draft only: publish will check it

      const updated = await updateTemplate(meetingOnly.id, { body: "<p>See you {{meeting.date}}</p>" });
      expect(updated.body).toContain("{{meeting.date}}");
    });

    it("still allows renaming a template used by a published non-meeting workflow", async () => {
      const shared = await template("Rename me", "<p>Hi {{lead.firstName}}</p>");
      await publish((await draftWorkflow("lead_created", shared.id)).id);
      await expect(updateTemplate(shared.id, { name: "Renamed" })).resolves.toMatchObject({ name: "Renamed" });
    });
  });
});
