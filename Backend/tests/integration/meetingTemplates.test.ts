/**
 * Default "Meeting Scheduled" templates are per workspace (audit B3). Runs
 * against a REAL database with every migration (including 019) applied.
 * Skipped unless TEST_DATABASE_URL is set; commits rows in two fresh
 * workspaces per run. The email/WhatsApp providers are mocked so the test
 * can see exactly what would be sent, without sending anything.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import type { Actor } from "../../src/authMiddleware.js";

const mocks = vi.hoisted(() => ({ sendEmail: vi.fn(), sendWhatsApp: vi.fn() }));
vi.mock("../../src/providers/email.provider.js", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("../../src/providers/whatsapp.provider.js", () => ({ sendWhatsApp: mocks.sendWhatsApp }));

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("default meeting templates are per workspace (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let actor: Actor;
  let authUserId: string | undefined;
  let workspaceA: string;
  let workspaceB: string;

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

  async function newWorkspace(): Promise<string> {
    const id = randomUUID();
    await pool.query(`insert into public.workspaces (id, name, slug) values ($1, $2, $2)`, [id, `meeting-tpl-test-${id}`]);
    return id;
  }

  /** Creates email + WhatsApp templates in a workspace and marks both as its meeting defaults. */
  async function setDefaults(workspaceId: string, marker: string) {
    const { createTemplate, updateTemplate } = await import("../../src/services/workflows.service.js");
    return inTransaction(async (client) => {
      const email = await createTemplate(client, actor, workspaceId, {
        name: `Meeting email ${marker}`,
        channel: "email",
        subject: `Subject ${marker}`,
        body: `<p>Email body ${marker} for {{lead.firstName}}</p>`,
      });
      const whatsapp = await createTemplate(client, actor, workspaceId, {
        name: `Meeting WhatsApp ${marker}`,
        channel: "whatsapp",
        body: `<p>WhatsApp body ${marker} for {{lead.firstName}}</p>`,
      });
      await updateTemplate(client, workspaceId, email.id, { isDefaultMeetingScheduled: true });
      await updateTemplate(client, workspaceId, whatsapp.id, { isDefaultMeetingScheduled: true });
      return { emailId: email.id, whatsappId: whatsapp.id };
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [
      `meeting-tpl-${randomUUID()}@example.com`,
    ]);
    authUserId = auth.rows[0].id as string;
    const profile = await pool.query(`select id, full_name, email from public.profiles where id = $1`, [authUserId]);
    actor = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "salesperson" };
    workspaceA = await newWorkspace();
    workspaceB = await newWorkspace();
  });

  afterAll(async () => {
    if (authUserId) {
      await pool.query(`delete from auth.users where id = $1`, [authUserId]).catch((error) => console.warn("[meetingTemplates] test user cleanup failed:", error));
    }
    await pool.end();
  });

  it("lets two workspaces each keep their own default email and WhatsApp template, and sends A's to A's meeting", async () => {
    const a = await setDefaults(workspaceA, "ALPHA");
    const b = await setDefaults(workspaceB, "BRAVO");

    // Setting B's defaults must not have cleared A's.
    const flags = await pool.query<{ id: string; is_default_meeting_scheduled_email: boolean; is_default_meeting_scheduled_whatsapp: boolean }>(
      `select id, is_default_meeting_scheduled_email, is_default_meeting_scheduled_whatsapp
         from public.message_templates where id = any($1::uuid[])`,
      [[a.emailId, a.whatsappId, b.emailId, b.whatsappId]],
    );
    const byId = new Map(flags.rows.map((row) => [row.id, row]));
    expect(byId.get(a.emailId)?.is_default_meeting_scheduled_email).toBe(true);
    expect(byId.get(b.emailId)?.is_default_meeting_scheduled_email).toBe(true);
    expect(byId.get(a.whatsappId)?.is_default_meeting_scheduled_whatsapp).toBe(true);
    expect(byId.get(b.whatsappId)?.is_default_meeting_scheduled_whatsapp).toBe(true);

    const { createLead } = await import("../../src/services/leads.service.js");
    const { scheduleMeeting } = await import("../../src/services/meetings.service.js");
    const { notifyMeetingScheduled, processQueuedMeetingWhatsappSend } = await import("../../src/services/meetingScheduledNotification.service.js");

    const lead = await inTransaction((client) =>
      createLead(client, actor, workspaceA, {
        firstName: "Asha",
        company: "Alpha Pvt Ltd",
        source: "referral",
        email: `asha-${randomUUID()}@example.com`,
        phone: `+9198${Math.floor(10000000 + Math.random() * 89999999)}`,
      }),
    );
    const meeting = await inTransaction((client) =>
      scheduleMeeting(client, actor, workspaceA, { leadId: lead.id, title: "Discovery", at: "2030-02-01T04:30:00.000Z", durationMin: 30 }),
    );

    mocks.sendEmail.mockResolvedValue({ providerMessageId: "test-email" });
    mocks.sendWhatsApp.mockResolvedValue({ providerMessageId: "test-wa" });
    await notifyMeetingScheduled(meeting.id);

    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    const [emailWorkspace, emailInput] = mocks.sendEmail.mock.calls[0]!;
    expect(emailWorkspace).toBe(workspaceA);
    expect(emailInput.subject).toBe("Subject ALPHA");
    expect(emailInput.html).toContain("Email body ALPHA for Asha");
    expect(emailInput.html).not.toContain("BRAVO");

    // The worker path: claim this one meeting directly (claimQueuedMeetingWhatsappSends scans every workspace).
    const claimed = await pool.query(
      `update public.meetings set notify_whatsapp_status = 'sending' where id = $1 and notify_whatsapp_status = 'queued' returning *`,
      [meeting.id],
    );
    expect(claimed.rowCount).toBe(1);
    await processQueuedMeetingWhatsappSend(claimed.rows[0]);

    expect(mocks.sendWhatsApp).toHaveBeenCalledOnce();
    const [waWorkspace, waInput] = mocks.sendWhatsApp.mock.calls[0]!;
    expect(waWorkspace).toBe(workspaceA);
    expect(waInput.body).toContain("WhatsApp body ALPHA for Asha");
    expect(waInput.body).not.toContain("BRAVO");

    const after = await pool.query(`select notify_email_status, notify_whatsapp_status from public.meetings where id = $1`, [meeting.id]);
    expect(after.rows[0]).toEqual({ notify_email_status: "sent", notify_whatsapp_status: "sent" });
  });
});
