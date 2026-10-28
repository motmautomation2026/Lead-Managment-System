/**
 * E1b: every email goes through the outbound queue and only the worker sends it.
 * A fake transport (nodemailer's stream transport: builds the real MIME message, no
 * network) stands in for SMTP; one fresh `[test]` workspace per scenario so pauses and
 * counts never leak. The claim is limited to these workspaces. Skipped unless
 * TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import type { Actor } from "../../src/authMiddleware.js";
import type { EmailTransport, OutgoingMail, TransportCache as TransportCacheType } from "../../src/providers/email.provider.js";
import type * as Outbound from "../../src/services/emailOutbound.service.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const PAUSE_TITLE = "Email sending paused automatically";
/** IST wall clock → Date ("2026-11-01T12:00" is a Sunday). */
const ist = (local: string) => new Date(`${local}:00+05:30`);
const smtpError = (responseCode: number, response: string) => Object.assign(new Error(response), { responseCode, response, code: "EENVELOPE" });

describeIfDb("E1b email outbound queue (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let admin: Actor;
  let outbound: typeof Outbound;
  let TransportCache: typeof TransportCacheType;
  const authUserIds: string[] = [];

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

  /** A fake SMTP server: records the MIME of each send, or throws the next queued error. */
  function fakeSmtp() {
    const sent: { mail: OutgoingMail; raw: string }[] = [];
    const errors: Error[] = [];
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const transport: EmailTransport = {
      async sendMail(mail) {
        const error = errors.shift();
        if (error) throw error;
        const info = await builder.sendMail(mail);
        sent.push({ mail, raw: (info.message as Buffer).toString("utf8") });
        return { messageId: info.messageId, response: "250 2.0.0 OK queued" };
      },
      verify: async () => true,
      close: () => undefined,
    };
    return { sent, errors, cache: new TransportCache(() => transport) };
  }

  /** An SMTP-configured workspace, window always open, no warm-up, spacing 1 s, unless `settings` says otherwise. */
  async function workspace(label: string, settings: Record<string, unknown> = {}) {
    const ws = await createTestWorkspace(pool, `email-${label}`);
    const { encryptJson } = await import("../../src/security/encryption.js");
    const secret = encryptJson({ smtpUsername: "crm@motm.example", smtpPassword: "app-password" }, "integration:email");
    await pool.query(
      `insert into public.integration_connections
         (workspace_id, id, provider, enabled, settings, secret_ciphertext, secret_iv, secret_tag, key_version,
          send_window_days, send_window_start, send_window_end, min_delay_seconds, max_delay_seconds)
       values ($1, 'email', 'smtp', true, $2, $3, $4, $5, $6, '{1,2,3,4,5,6,7}', '00:00', '23:59:59', 1, 1)`,
      [
        ws,
        { senderName: "MOTM Sales", senderAddress: "crm@motm.example", replyTo: "replies@motm.example", smtpHost: "smtp.motm.example", smtpPort: 465, smtpSecurity: "ssl" },
        secret.ciphertext,
        secret.iv,
        secret.tag,
        secret.keyVersion,
      ],
    );
    const entries = Object.entries(settings);
    if (entries.length) {
      await pool.query(
        `update public.integration_connections set ${entries.map(([key], i) => `${key} = $${i + 2}`).join(", ")} where workspace_id = $1 and id = 'email'`,
        [ws, ...entries.map(([, value]) => value)],
      );
    }
    return ws;
  }

  async function lead(ws: string, extra: Record<string, unknown> = {}) {
    const { createLead } = await import("../../src/services/leads.service.js");
    const email = `asha-${randomUUID()}@example.com`;
    const created = await inTransaction((client) =>
      createLead(client, admin, ws, { firstName: "Asha", company: "Asha Pvt Ltd", source: "referral", email, ownerId: admin.id, ...extra }),
    );
    return { id: created.id, email };
  }

  /** A queued email to a contact from a rep's (filler) proposal. */
  async function proposalEmail(ws: string, leadId: string, to: string) {
    const { createProposal } = await import("../../src/services/proposals.service.js");
    const proposal = await inTransaction((client) => createProposal(client, admin, ws, { leadId, title: "Filler", emailSendStatus: "pending", whatsappSendStatus: "skipped" }));
    const row = await outbound.enqueueEmail(pool, { workspaceId: ws, source: "proposal", sourceId: proposal.id, leadId, to, subject: "Your proposal", html: "<p>Hello</p>" });
    return { proposalId: proposal.id, row };
  }

  /** A workflow send_email step claimed by the worker (`executing`), with its queued email. */
  async function workflowEmail(ws: string, leadId: string, to: string) {
    const { createTemplate, createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const { enrollLeadInWorkflow } = await import("../../src/services/runs.service.js");
    const template = await inTransaction((client) => createTemplate(client, admin, ws, { name: `E1b ${randomUUID()}`, channel: "email", subject: "Hi", body: "<p>Hi</p>" }));
    const workflow = await inTransaction((client) => createWorkflow(client, admin, ws, { name: `E1b ${randomUUID()}`, trigger: "manual_enrollment" }));
    // delayDays 1 keeps a live staging worker from claiming the action first.
    await inTransaction((client) => updateDraftSteps(client, ws, workflow.id, 1, [{ order: 0, delayDays: 1, action: "send_email", templateId: template.id, enabled: true }]));
    await inTransaction((client) => publishVersion(client, admin, ws, workflow.id, 1, "keep_existing"));
    await inTransaction((client) => updateWorkflow(client, ws, workflow.id, { status: "active" }));
    const run = await inTransaction((client) => enrollLeadInWorkflow(client, ws, leadId, workflow.id, "E1b test"));
    const action = await pool.query<{ id: string }>(
      `update public.scheduled_actions set status = 'executing', last_attempt_at = now() where workflow_run_id = $1 returning id`,
      [run!.id],
    );
    const actionId = action.rows[0]!.id;
    const row = await outbound.queueEmailForAction({ workspaceId: ws, sourceId: actionId, leadId, to, subject: "Hi", html: "<p>Hi</p>" });
    return { actionId, row };
  }

  /** `count` emails sent now (fillers, source `test`). */
  async function sentNow(ws: string, count: number) {
    await pool.query(
      `insert into public.email_outbound_messages (workspace_id, source, source_id, to_address, subject, html, text_body, status, sent_at)
       select $1, 'test', gen_random_uuid(), 'filler@example.com', 'f', 'f', 'f', 'sent', now() from generate_series(1, $2)`,
      [ws, count],
    );
  }

  const run = (ws: string, smtp: ReturnType<typeof fakeSmtp>, extra: Partial<Outbound.EmailOutboundDeps> = {}) =>
    outbound.runEmailOutbound({ workspaceIds: [ws], transports: smtp.cache, wait: async () => undefined, ...extra });

  const email = async (id: string) => (await pool.query(`select * from public.email_outbound_messages where id = $1`, [id])).rows[0];
  const connection = async (ws: string) =>
    (await pool.query(`select enabled, paused_reason, paused_at from public.integration_connections where workspace_id = $1 and id = 'email'`, [ws])).rows[0];
  const pauseNotifications = async (ws: string) =>
    (await pool.query<{ n: number }>(`select count(*)::int as n from public.notifications where workspace_id = $1 and title = $2`, [ws, PAUSE_TITLE])).rows[0]!.n;
  const activeAdmins = async () => (await pool.query<{ n: number }>(`select count(*)::int as n from public.profiles where role = 'admin' and is_active`)).rows[0]!.n;
  const makeDue = (ws: string) => pool.query(`update public.email_outbound_messages set next_attempt_at = now() where workspace_id = $1 and status = 'queued'`, [ws]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    outbound = await import("../../src/services/emailOutbound.service.js");
    ({ TransportCache } = await import("../../src/providers/email.provider.js"));
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`email-e1b-${randomUUID()}@example.com`]);
    authUserIds.push(auth.rows[0].id as string);
    const profile = await pool.query(
      `update public.profiles set role = 'admin', is_active = true, full_name = 'E1b Admin' where id = $1 returning id, full_name, email`,
      [auth.rows[0].id],
    );
    admin = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "admin" };
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    // resumeEmail writes an append-only admin audit row, so the admin can't be deleted: deactivate it first.
    await pool.query(`update public.profiles set is_active = false where id = any($1::uuid[])`, [authUserIds]);
    for (const id of authUserIds) {
      await pool.query(`delete from auth.users where id = $1`, [id]).catch((error) => console.warn("[emailOutbound] test user cleanup failed:", error));
    }
    await pool.end();
  });

  it("POST /proposals only queues; the worker sends it with the document attached and the deliverability headers", async () => {
    const ws = await workspace("proposal");
    const contact = await lead(ws);
    const { createTemplate } = await import("../../src/services/workflows.service.js");
    const emailTemplate = await inTransaction((c) => createTemplate(c, admin, ws, { name: "Proposal email", channel: "email", subject: "Proposal for {{lead.firstName}}", body: "<p>Hi {{lead.firstName}}, attached.</p>" }));
    const waTemplate = await inTransaction((c) => createTemplate(c, admin, ws, { name: "Proposal WA", channel: "whatsapp", body: "Hi" }));
    const { createAndSendProposal } = await import("../../src/services/proposalSending.service.js");
    const smtp = fakeSmtp();

    const proposal = await createAndSendProposal(
      admin,
      ws,
      { leadId: contact.id, title: "E1b proposal", emailTemplateId: emailTemplate.id, whatsappTemplateId: waTemplate.id },
      { buffer: Buffer.from("%PDF-1.4 e1b"), originalName: "proposal.pdf", mimeType: "application/pdf", size: 12 },
    );
    expect(proposal.emailSendStatus).toBe("pending");
    expect(smtp.sent).toHaveLength(0);

    expect(await run(ws, smtp)).toEqual(["sent"]);
    expect(smtp.sent).toHaveLength(1);
    const { raw, mail } = smtp.sent[0]!;
    const row = (await pool.query(`select * from public.email_outbound_messages where source = 'proposal' and source_id = $1`, [proposal.id])).rows[0];
    expect(row).toMatchObject({ status: "sent", to_address: contact.email, subject: "Proposal for Asha", dry_run: false, smtp_response: "250 2.0.0 OK queued" });
    expect(row.message_id).toMatch(/^<[0-9a-f-]{36}@motm\.example>$/);
    expect(raw).toContain(`Message-ID: ${row.message_id}`);
    const company = (await pool.query(`select name from public.workspaces where id = $1`, [ws])).rows[0].name as string;
    expect(mail.from).toEqual({ name: `E1b Admin | ${company}`, address: "crm@motm.example" });
    expect(raw).toMatch(/^Reply-To: replies@motm\.example/m);
    expect(raw).toMatch(/^List-Unsubscribe: <mailto:replies@motm\.example\?subject=unsubscribe>/m);
    expect(raw).toMatch(/^Date: /m);
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(raw).toContain("Hi Asha, attached.");
    expect(raw).toMatch(/filename=proposal\.pdf/);
    expect(raw).not.toMatch(/Precedence:/i);

    const after = (await pool.query(`select email_send_status, email_sent_at, status from public.proposals where id = $1`, [proposal.id])).rows[0];
    expect(after.email_send_status).toBe("sent");
    expect(after.email_sent_at).not.toBeNull();
    expect(after.status).toBe("sent");
  });

  it("one email per source key, even when enqueued twice and claimed by two ticks at once", async () => {
    const ws = await workspace("once");
    const contact = await lead(ws);
    const { proposalId, row } = await proposalEmail(ws, contact.id, contact.email);
    const again = await outbound.enqueueEmail(pool, { workspaceId: ws, source: "proposal", sourceId: proposalId, leadId: contact.id, to: contact.email, subject: "x", html: "x" });
    expect(again.id).toBe(row.id);

    const smtp = fakeSmtp();
    const [a, b] = await Promise.all([run(ws, smtp), run(ws, smtp)]);
    expect([...a, ...b]).toEqual(["sent"]);
    expect(smtp.sent).toHaveLength(1);
    expect(await run(ws, smtp)).toEqual([]);
  });

  it("a workflow email is deferred on Sunday (send window), a proposal email is not; the step follows its email", async () => {
    const ws = await workspace("window", { send_window_days: [1, 2, 3, 4, 5, 6], send_window_start: "09:30", send_window_end: "19:00" });
    const contact = await lead(ws);
    const smtp = fakeSmtp();
    const sunday = () => ist("2026-11-01T12:00");

    const step = await workflowEmail(ws, contact.id, contact.email);
    expect(await run(ws, smtp, { now: sunday })).toEqual(["queued"]);
    const deferred = await email(step.row.id);
    expect(deferred).toMatchObject({ status: "queued", attempts: 0, last_error: "Outside the email send window." });
    expect(deferred.next_attempt_at.getTime()).toBeGreaterThanOrEqual(ist("2026-11-02T09:30").getTime());

    const rep = await proposalEmail(ws, contact.id, contact.email);
    expect(await run(ws, smtp, { now: sunday })).toEqual(["sent"]);
    expect(smtp.sent.map((s) => s.mail.subject)).toEqual(["Your proposal"]);
    expect((await email(rep.row.id)).status).toBe("sent");

    // A step that is no longer active cancels its email; running again re-queues it.
    await pool.query(`update public.scheduled_actions set status = 'cancelled', cancelled_at = now() where id = $1`, [step.actionId]);
    await makeDue(ws);
    expect(await run(ws, smtp)).toEqual(["cancelled"]);
    await pool.query(`update public.scheduled_actions set status = 'executing', cancelled_at = null where id = $1`, [step.actionId]);
    const requeued = await outbound.queueEmailForAction({ workspaceId: ws, sourceId: step.actionId, leadId: contact.id, to: contact.email, subject: "Hi", html: "<p>Hi</p>" });
    expect(requeued).toMatchObject({ id: step.row.id, status: "queued" });
  });

  it("warm-up: day 2 caps the day at 20; 'already warmed' lifts it", async () => {
    const ws = await workspace("warmup", { configured_at: new Date(Date.now() - 24 * 3600 * 1000), hourly_cap: 1000 });
    const contact = await lead(ws);
    await sentNow(ws, 20);
    const { row } = await proposalEmail(ws, contact.id, contact.email);
    const smtp = fakeSmtp();
    expect(await run(ws, smtp)).toEqual(["queued"]);
    expect((await email(row.id)).last_error).toBe("Warm-up daily cap (20) reached.");

    await pool.query(`update public.integration_connections set already_warmed = true where workspace_id = $1 and id = 'email'`, [ws]);
    await makeDue(ws);
    expect(await run(ws, smtp)).toEqual(["sent"]);
  });

  it("the hourly cap defers the 21st email of the hour; spacing defers a too-early email", async () => {
    const ws = await workspace("hourly");
    const contact = await lead(ws);
    await sentNow(ws, 20);
    const { row, proposalId } = await proposalEmail(ws, contact.id, contact.email);
    const smtp = fakeSmtp();
    expect(await run(ws, smtp)).toEqual(["queued"]);
    expect((await email(row.id)).last_error).toBe("Hourly cap (20) reached.");
    // The rep's proposal shows why it is still queued.
    expect((await pool.query(`select email_send_status, email_send_error from public.proposals where id = $1`, [proposalId])).rows[0]).toEqual({
      email_send_status: "pending",
      email_send_error: "Hourly cap (20) reached.",
    });

    const spaced = await workspace("spacing");
    const other = await lead(spaced);
    const next = new Date(Date.now() + 5 * 60_000);
    await pool.query(`update public.integration_connections set next_send_at = $2 where workspace_id = $1 and id = 'email'`, [spaced, next]);
    const second = await proposalEmail(spaced, other.id, other.email);
    expect(await run(spaced, smtp)).toEqual(["queued"]);
    const waiting = await email(second.row.id);
    expect(waiting.last_error).toBe("Spacing emails.");
    expect(waiting.next_attempt_at.getTime()).toBe(next.getTime());
    expect(smtp.sent).toHaveLength(0);
  });

  it("550 5.1.1 fails the email and marks the contact's email invalid", async () => {
    const ws = await workspace("bounce");
    const contact = await lead(ws);
    const { row, proposalId } = await proposalEmail(ws, contact.id, contact.email);
    const smtp = fakeSmtp();
    smtp.errors.push(smtpError(550, "550 5.1.1 <x@example.com>: Recipient address rejected: User unknown"));
    expect(await run(ws, smtp)).toEqual(["failed"]);
    expect((await email(row.id)).last_error).toMatch(/^The recipient's mail server rejected the email: 550 5\.1\.1/);
    expect((await pool.query(`select status from public.lead_contact_channels where lead_id = $1 and channel = 'email'`, [contact.id])).rows[0].status).toBe("invalid");
    expect((await pool.query(`select email_send_status from public.proposals where id = $1`, [proposalId])).rows[0].email_send_status).toBe("failed");
    expect((await connection(ws)).enabled).toBe(true);

    // The next email to that contact fails before any SMTP call.
    const next = await proposalEmail(ws, contact.id, contact.email);
    expect(await run(ws, smtp)).toEqual(["failed"]);
    expect((await email(next.row.id)).last_error).toBe("The contact's email address is marked invalid.");
  });

  it("535 pauses sending, notifies every admin once, and later emails defer; resume lets them go", async () => {
    const ws = await workspace("login");
    const contact = await lead(ws);
    const first = await proposalEmail(ws, contact.id, contact.email);
    const smtp = fakeSmtp();
    smtp.errors.push(smtpError(535, "535 5.7.8 Username and Password not accepted"));
    expect(await run(ws, smtp)).toEqual(["queued"]);
    expect(await connection(ws)).toMatchObject({ enabled: false, paused_reason: "SMTP login rejected — check the password." });
    expect(await pauseNotifications(ws)).toBe(await activeAdmins());
    expect(await email(first.row.id)).toMatchObject({ status: "queued", attempts: 0 });

    const second = await proposalEmail(ws, contact.id, contact.email);
    await makeDue(ws);
    expect(await run(ws, smtp)).toEqual(["queued"]);
    expect(await run(ws, smtp)).toEqual(["queued"]);
    expect((await email(second.row.id)).last_error).toBe("Email sending is paused.");
    expect(await pauseNotifications(ws)).toBe(await activeAdmins());

    const { resumeEmail } = await import("../../src/services/emailConnection.service.js");
    await resumeEmail(admin, ws);
    await makeDue(ws);
    expect(await run(ws, smtp)).toEqual(["sent"]);
    await makeDue(ws);
    expect(await run(ws, smtp)).toEqual(["sent"]);
    expect(smtp.sent).toHaveLength(2);
  });

  it("421 4.7.0 (rate limit) pauses with the server's reason", async () => {
    const ws = await workspace("ratelimit");
    const contact = await lead(ws);
    await proposalEmail(ws, contact.id, contact.email);
    const smtp = fakeSmtp();
    smtp.errors.push(smtpError(421, "421 4.7.0 Try again later, closing connection"));
    await run(ws, smtp);
    expect(await connection(ws)).toMatchObject({ enabled: false, paused_reason: "The mail server is limiting our sending: 421 4.7.0 Try again later, closing connection" });
  });

  it("D3 8a: 451 pauses only with 4.7.x or rate-limit wording; 451 4.3.0 is a temporary retry", async () => {
    for (const [response, pauses] of [
      ["451 4.3.0 Temporary local problem", false],
      ["451 4.7.0 Temporary server error", true],
      ["451 Too many connections, try later", true],
    ] as const) {
      const ws = await workspace(`451-${pauses}`);
      const contact = await lead(ws);
      const { row } = await proposalEmail(ws, contact.id, contact.email);
      const smtp = fakeSmtp();
      smtp.errors.push(smtpError(451, response));
      await run(ws, smtp);
      expect((await connection(ws)).enabled).toBe(!pauses);
      expect(await email(row.id)).toMatchObject({ status: "queued", attempts: pauses ? 0 : 1 });
    }
  });

  it("D3 8b: a queued meeting email is cancelled once the meeting has started or was cancelled", async () => {
    const ws = await workspace("meeting-stale");
    const contact = await lead(ws);
    const meeting = async (scheduledAt: Date, status: string) =>
      (
        await pool.query<{ id: string }>(
          `insert into public.meetings (workspace_id, lead_id, title, scheduled_at, status, notify_email_status) values ($1, $2, 'Demo', $3, $4, 'pending') returning id`,
          [ws, contact.id, scheduledAt, status],
        )
      ).rows[0]!.id;
    const cases = [
      [await meeting(new Date(Date.now() - 60_000), "scheduled"), "Meeting time has passed"],
      [await meeting(new Date(Date.now() + 86_400_000), "cancelled"), "Meeting was cancelled"],
    ] as const;
    const smtp = fakeSmtp();
    for (const [meetingId, reason] of cases) {
      const row = await outbound.enqueueEmail(pool, { workspaceId: ws, source: "meeting", sourceId: meetingId, leadId: contact.id, to: contact.email, subject: "Meeting", html: "<p>See you</p>" });
      expect(await run(ws, smtp)).toEqual(["cancelled"]);
      expect(await email(row.id)).toMatchObject({ status: "cancelled", last_error: reason });
      expect((await pool.query(`select notify_email_status, notify_email_error from public.meetings where id = $1`, [meetingId])).rows[0]).toEqual({
        notify_email_status: "skipped",
        notify_email_error: reason,
      });
    }
    expect(smtp.sent).toHaveLength(0);
  });

  it("5 temporary failures in 30 minutes pause sending; each burns one attempt", async () => {
    const ws = await workspace("temporary");
    const smtp = fakeSmtp();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const contact = await lead(ws);
      ids.push((await proposalEmail(ws, contact.id, contact.email)).row.id);
      smtp.errors.push(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      await pool.query(`update public.integration_connections set next_send_at = null where workspace_id = $1 and id = 'email'`, [ws]);
      expect(await run(ws, smtp)).toEqual(["queued"]);
    }
    expect(await connection(ws)).toMatchObject({ enabled: false, paused_reason: "5 email send failures in 30 minutes." });
    for (const id of ids) expect(await email(id)).toMatchObject({ status: "queued", attempts: 1 });
  });

  it("not set up (provider resend or none) defers with the message, never fails", async () => {
    for (const provider of ["resend", null]) {
      const ws = await workspace(`unset-${provider}`, { provider });
      const contact = await lead(ws);
      const { row, proposalId } = await proposalEmail(ws, contact.id, contact.email);
      expect(await run(ws, fakeSmtp())).toEqual(["queued"]);
      const message = "Email is not set up. An admin must add the SMTP mailbox in Settings → Email.";
      expect(await email(row.id)).toMatchObject({ status: "queued", attempts: 0, last_error: message });
      expect((await pool.query(`select email_send_status, email_send_error from public.proposals where id = $1`, [proposalId])).rows[0]).toEqual({
        email_send_status: "pending",
        email_send_error: message,
      });
    }
  });

  it("Do Not Contact and unsubscribed contacts fail with the reason", async () => {
    const ws = await workspace("blocked");
    const dnc = await lead(ws);
    const unsubscribed = await lead(ws);
    const a = await proposalEmail(ws, dnc.id, dnc.email);
    const b = await proposalEmail(ws, unsubscribed.id, unsubscribed.email);
    await pool.query(`update public.leads set lifecycle_state = 'do_not_contact', dnc_reason = 'Asked not to be contacted' where id = $1`, [dnc.id]);
    await pool.query(`insert into public.lead_contact_channels (lead_id, channel, status) values ($1, 'email', 'unsubscribed')`, [unsubscribed.id]);
    const smtp = fakeSmtp();
    await run(ws, smtp);
    await run(ws, smtp);
    expect((await email(a.row.id)).last_error).toBe("The contact is Do Not Contact.");
    expect((await email(b.row.id)).last_error).toBe("The contact unsubscribed from email.");
    expect(smtp.sent).toHaveLength(0);
  });

  it("dry run renders and marks sent without an SMTP call (even with no mailbox)", async () => {
    const ws = await workspace("dryrun", { provider: null });
    const contact = await lead(ws);
    const { row, proposalId } = await proposalEmail(ws, contact.id, contact.email);
    const smtp = fakeSmtp();
    expect(await run(ws, smtp, { dryRun: true })).toEqual(["sent"]);
    expect(await email(row.id)).toMatchObject({ status: "sent", dry_run: true, smtp_response: "DRY_RUN" });
    expect(smtp.sent).toHaveLength(0);
    expect((await pool.query(`select email_send_status from public.proposals where id = $1`, [proposalId])).rows[0].email_send_status).toBe("sent");
  });
});
