/**
 * LL-2 rule 3: staff email alerts + morning digest + the Profile toggles. WRITTEN IN LL-2, NOT RUN THERE (staging was
 * down): INT-1 runs it. No real SMTP: the mailbox and transport are injected fakes. Skipped unless TEST_DATABASE_URL is
 * set; [test] workspaces only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { addTestMember, createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";
import type { Mailbox } from "../../src/services/emailConnection.service.js";
import type { EmailTransport, OutgoingMail } from "../../src/providers/email.provider.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const BOX = { fromName: "MOTM", fromAddress: "crm@motm.example", replyTo: "crm@motm.example", transportKey: "k", smtp: {} } as unknown as Mailbox;

describeIfDb("LL-2 staff email alerts (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let rep: Actor;
  let admin: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "ll2-staff");
    rep = await api.newUser("salesperson", { name: "LL2 Staff Rep" });
    admin = await api.newUser("admin", { name: "LL2 Staff Admin" });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  async function workspace() {
    const ws = await createTestWorkspace(pool, "ll2-staff");
    await addTestMember(pool, ws, rep.id, "salesperson");
    await addTestMember(pool, ws, admin.id, "admin");
    return ws;
  }

  const fakeTransport = () => {
    const sent: OutgoingMail[] = [];
    const transport: EmailTransport = { sendMail: async (m) => (sent.push(m), { response: "250 OK" }), verify: async () => true, close: () => undefined };
    return { sent, transport: () => transport };
  };
  const bell = (ws: string, recipient: string, title: string) =>
    pool.query(`insert into public.notifications (workspace_id, recipient_id, title, kind, email_status) values ($1, $2, $3, 'info', 'pending') returning id`, [ws, recipient, title]);

  it("Profile toggles: GET /me shows them (default on), PATCH /me changes only what is sent", async () => {
    const ws = await workspace();
    const me = await api.call(rep, ws, "GET", "/me");
    expect(me.body).toMatchObject({ emailAlertsEnabled: true, emailDigestEnabled: true });
    const res = await api.call(rep, ws, "PATCH", "/me", { emailDigestEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ emailAlertsEnabled: true, emailDigestEnabled: false });
    expect((await api.call(rep, ws, "PATCH", "/me", {})).status).toBe(400);
    await api.call(rep, ws, "PATCH", "/me", { emailDigestEnabled: true });
  });

  it("two urgent bells → one email to the login email; marked sent; nothing in the lead email queue", async () => {
    const ws = await workspace();
    await bell(ws, rep.id, "WhatsApp reply received");
    await bell(ws, rep.id, "Email reply received");
    const t = fakeTransport();
    const { runStaffAlertEmails } = await import("../../src/services/staffAlerts.service.js");
    await runStaffAlertEmails({ mailbox: async (id) => (id === ws ? BOX : null), transport: t.transport, baseUrl: "https://crm.example.com" });
    const mine = t.sent.filter((m) => m.to === rep.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toBe("MOTM Flow: 2 urgent alerts");
    const statuses = await pool.query(`select email_status from public.notifications where workspace_id = $1 and recipient_id = $2`, [ws, rep.id]);
    expect(statuses.rows.map((r) => r.email_status)).toEqual(["sent", "sent"]);
    const queued = await pool.query(`select 1 from public.email_outbound_messages where workspace_id = $1`, [ws]);
    expect(queued.rowCount).toBe(0);
  });

  it("no mailbox → skipped + one admin warning per workspace", async () => {
    const ws = await workspace();
    await bell(ws, rep.id, "Email reply received");
    const { runStaffAlertEmails } = await import("../../src/services/staffAlerts.service.js");
    await runStaffAlertEmails({ mailbox: async () => null });
    await bell(ws, rep.id, "Email reply received");
    await runStaffAlertEmails({ mailbox: async () => null });
    const warnings = await pool.query(`select recipient_id from public.notifications where workspace_id = $1 and title = 'Staff email alerts are off: no mailbox'`, [ws]);
    expect(warnings.rows).toEqual([{ recipient_id: admin.id }]);
  });

  it("admins change the toggles for a salesperson in Users (audited)", async () => {
    const ws = await workspace();
    const res = await api.call(admin, ws, "PATCH", `/admin/users/${rep.id}`, { emailAlertsEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ emailAlertsEnabled: false });
    await api.call(admin, ws, "PATCH", `/admin/users/${rep.id}`, { emailAlertsEnabled: true });
  });
});
