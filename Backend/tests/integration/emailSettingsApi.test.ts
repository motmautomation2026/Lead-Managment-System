/**
 * E1b email API: settings (read for every CRM user without secrets, write admin-only),
 * SMTP / IMAP login tests (fake clients), "Send test email to me" (queued, sent by the
 * worker with a fake transport), resume, and the deliverability check (fake DNS).
 * Real HTTP stack, `[test]` workspace; nothing contacts a real server. Skipped unless
 * TEST_DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import type { TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const mocks = vi.hoisted(() => ({
  smtp: { error: null as Error | null },
  imap: { error: null as Error | null, folders: [] as string[] },
  dns: {
    txt: {} as Record<string, string[][]>,
    mx: {} as Record<string, { exchange: string; priority: number }[]>,
  },
}));

vi.mock("../../src/providers/email.provider.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/providers/email.provider.js")>();
  const fakeTransport = () => ({
    sendMail: async () => ({ response: "250 OK" }),
    verify: async () => {
      if (mocks.smtp.error) throw mocks.smtp.error;
      return true;
    },
    close: () => undefined,
  });
  return {
    ...original,
    defaultTransportCache: new original.TransportCache(fakeTransport),
    verifySmtp: (config: Parameters<typeof original.verifySmtp>[0]) => original.verifySmtp(config, fakeTransport),
    verifyImap: (config: Parameters<typeof original.verifyImap>[0]) =>
      original.verifyImap(config, () => ({
        connect: async () => {
          if (mocks.imap.error) throw mocks.imap.error;
        },
        mailboxOpen: async (path: string) => {
          mocks.imap.folders.push(path);
          if (path !== "INBOX") throw Object.assign(new Error("Command failed"), { serverResponseCode: "NONEXISTENT" });
        },
        logout: async () => undefined,
        close: () => undefined,
      })),
  };
});

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    async resolveMx(name: string) {
      const records = mocks.dns.mx[name];
      if (!records) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return records;
    }
    async resolveTxt(name: string) {
      const records = mocks.dns.txt[name];
      if (!records) throw Object.assign(new Error("no data"), { code: "ENODATA" });
      return records;
    }
  },
}));

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const SECRET = "app-password-never-shown";

describeIfDb("E1b email settings API (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let admin: Actor;
  let rep: Actor;
  let ws: string;

  const settings = {
    enabled: true,
    smtpHost: "smtp.motm.example",
    smtpPort: 465,
    smtpSecurity: "ssl",
    smtpUsername: "crm@motm.example",
    smtpPassword: SECRET,
    fromAddress: "crm@motm.example",
    fromName: "MOTM Sales",
    replyTo: "",
    imapHost: "imap.motm.example",
    imapPort: 993,
    imapSecurity: "ssl",
    imapSameLogin: true,
    imapFolder: "INBOX",
    dailyCap: 100,
    hourlyCap: 20,
    minDelaySeconds: 30,
    maxDelaySeconds: 90,
    sendWindow: { days: [1, 2, 3, 4, 5, 6], start: "09:30", end: "19:00" },
    alreadyWarmed: false,
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const { startTestApi } = await import("../helpers/testApi.js");
    api = await startTestApi(pool, "email-api");
    admin = await api.newUser("admin", { name: "E1b Admin" });
    rep = await api.newUser("salesperson", { name: "E1b Rep" });
    ws = await createTestWorkspace(pool, "email-api");
    // A workspace still on Resend: "not set up" until an admin saves SMTP.
    await pool.query(`insert into public.integration_connections (workspace_id, id, provider, enabled, settings) values ($1, 'email', 'resend', true, $2)`, [
      ws,
      { senderName: "Old", senderAddress: "old@motm.example" },
    ]);
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    // Admin audit rows are append-only, so the admin can't be deleted: leave no active test user behind.
    await pool.query(`update public.profiles set is_active = false where id = any($1::uuid[])`, [[admin.id, rep.id]]);
    await api.close();
    await pool.end();
  });

  it("a workspace on Resend reads as not set up; everyone may read, defaults are the decided limits", async () => {
    const res = await api.call(rep, ws, "GET", "/connections/email/settings");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: false,
      legacyProvider: "resend",
      dailyCap: 100,
      hourlyCap: 20,
      minDelaySeconds: 30,
      maxDelaySeconds: 90,
      sendWindow: { days: [1, 2, 3, 4, 5, 6], start: "09:30", end: "19:00" },
      imapPort: 993,
      imapFolder: "INBOX",
      alreadyWarmed: false,
      configuredAt: null,
      pause: null,
      sentToday: 0,
      failures24h: 0,
      rejections24h: 0,
      // E3b-2b: open tracking is off by default (the test env has no PUBLIC_API_BASE_URL).
      trackOpens: false,
      openTrackingAvailable: false,
    });
    expect(res.body.daily).toHaveLength(14);
  });

  it("E3b-2b: only an admin turns Track email opens on or off (audited)", async () => {
    expect((await api.call(rep, ws, "PUT", "/connections/email/track-opens", { enabled: true })).status).toBe(403);
    expect((await api.call(admin, ws, "PUT", "/connections/email/track-opens", { enabled: "yes" })).status).toBe(400);
    const on = await api.call(admin, ws, "PUT", "/connections/email/track-opens", { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.trackOpens).toBe(true);
    const off = await api.call(admin, ws, "PUT", "/connections/email/track-opens", { enabled: false });
    expect(off.body.trackOpens).toBe(false);
    const audit = await pool.query(`select count(*)::int as n from public.admin_audit_events where action = 'connection.email.track_opens' and target_id = $1`, [`${ws}:email`]);
    expect(audit.rows[0].n).toBe(2);
  });

  it("only admins write, test, send a test, resume or check DNS (403 for a salesperson)", async () => {
    for (const [method, path, body] of [
      ["PUT", "/connections/email/settings", settings],
      ["POST", "/connections/email/test-smtp"],
      ["POST", "/connections/email/test-imap"],
      ["POST", "/connections/email/test-send"],
      ["POST", "/connections/email/resume"],
      ["GET", "/connections/email/deliverability"],
    ] as const) {
      expect((await api.call(rep, ws, method, path, body)).status).toBe(403);
    }
  });

  it("validates: provider resend, ports, spacing, caps, window", async () => {
    const bad = async (patch: Record<string, unknown>) => api.call(admin, ws, "PUT", "/connections/email/settings", { ...settings, ...patch });
    const resend = await bad({ provider: "resend" });
    expect(resend.status).toBe(400);
    expect(JSON.stringify(resend.body)).toContain("Resend is no longer supported");
    for (const patch of [
      { smtpPort: 0 },
      { imapPort: 70000 },
      { minDelaySeconds: 100, maxDelaySeconds: 90 },
      { dailyCap: 0 },
      { hourlyCap: 0 },
      { sendWindow: { days: [1], start: "19:00", end: "09:30" } },
      { fromAddress: "not-an-email" },
    ]) {
      expect((await bad(patch)).status).toBe(400);
    }
    expect((await bad({ smtpPassword: "" })).status).toBe(400); // no saved password yet
  });

  it("saves SMTP + IMAP; secrets are write-only and blank keeps them; warm-up starts", async () => {
    const res = await api.call(admin, ws, "PUT", "/connections/email/settings", settings);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, legacyProvider: null, smtpUsernameConfigured: true, smtpPasswordConfigured: true, warmupDay: 1, effectiveDailyCap: 20 });
    expect(res.body.configuredAt).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(SECRET);

    const kept = await api.call(admin, ws, "PUT", "/connections/email/settings", { ...settings, smtpPassword: "", alreadyWarmed: true });
    expect(kept.body).toMatchObject({ configured: true, smtpPasswordConfigured: true, warmupDay: null, effectiveDailyCap: 100, configuredAt: res.body.configuredAt });

    const read = await api.call(rep, ws, "GET", "/connections/email/settings");
    expect(JSON.stringify(read.body)).not.toContain(SECRET);
    expect(read.body).not.toHaveProperty("smtpPassword");
    expect(read.body).not.toHaveProperty("smtpUsername");
  });

  it("Test SMTP login / Test IMAP login give clear results", async () => {
    mocks.smtp.error = null;
    expect((await api.call(admin, ws, "POST", "/connections/email/test-smtp")).body).toEqual({ ok: true, message: "Logged in to smtp.motm.example:465. Nothing was sent." });
    mocks.smtp.error = Object.assign(new Error("Invalid login: 535 5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 });
    const rejected = (await api.call(admin, ws, "POST", "/connections/email/test-smtp")).body;
    expect(rejected).toMatchObject({ ok: false, message: expect.stringContaining("app password") });

    mocks.imap.error = null;
    expect((await api.call(admin, ws, "POST", "/connections/email/test-imap")).body).toMatchObject({ ok: true });
    await api.call(admin, ws, "PUT", "/connections/email/settings", { ...settings, smtpPassword: "", imapFolder: "Replies" });
    expect((await api.call(admin, ws, "POST", "/connections/email/test-imap")).body).toEqual({ ok: false, message: 'The folder "Replies" doesn\'t exist in this mailbox.' });
    mocks.imap.error = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    expect((await api.call(admin, ws, "POST", "/connections/email/test-imap")).body.message).toBe('Couldn\'t find the server "imap.motm.example". Check the host name.');
    mocks.imap.error = null;
    await api.call(admin, ws, "PUT", "/connections/email/settings", { ...settings, smtpPassword: "" });
  });

  it("'Send test email to me' is queued, sent by the worker, and its result readable", async () => {
    const queued = await api.call(admin, ws, "POST", "/connections/email/test-send");
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ status: "queued" });
    expect((await api.call(admin, ws, "GET", `/connections/email/test-send/${queued.body.id}`)).body).toMatchObject({ status: "queued", to: admin.email });

    await pool.query(`update public.integration_connections set send_window_days = '{1,2,3,4,5,6,7}', send_window_start = '00:00', send_window_end = '23:59:59' where workspace_id = $1 and id = 'email'`, [ws]);
    const { runEmailOutbound } = await import("../../src/services/emailOutbound.service.js");
    expect(await runEmailOutbound({ workspaceIds: [ws] })).toEqual(["sent"]);
    expect((await api.call(admin, ws, "GET", `/connections/email/test-send/${queued.body.id}`)).body).toMatchObject({ status: "sent", lastError: null });
    expect((await api.call(admin, ws, "GET", "/connections/email/test-send/not-a-uuid")).status).toBe(400);

    const monitoring = (await api.call(rep, ws, "GET", "/connections/email/settings")).body;
    expect(monitoring).toMatchObject({ sentToday: 1, sentThisHour: 1 });
    expect(monitoring.daily[0].sent).toBe(1);
  });

  it("a paused mailbox shows the pause to everyone; only an admin resumes", async () => {
    await pool.query(
      `update public.integration_connections set enabled = false, paused_reason = 'SMTP login rejected — check the password.', paused_at = now() where workspace_id = $1 and id = 'email'`,
      [ws],
    );
    const read = await api.call(rep, ws, "GET", "/connections/email/settings");
    expect(read.body.pause).toMatchObject({ reason: "SMTP login rejected — check the password.", byName: null });
    const resumed = await api.call(admin, ws, "POST", "/connections/email/resume");
    expect(resumed.body).toMatchObject({ enabled: true, pause: null });
    expect(resumed.body.safetyEvents[0]).toMatchObject({ kind: "resumed", detail: "Resumed by E1b Admin" });
  });

  it("the deliverability check grades MX, SPF, DKIM and DMARC for the from domain", async () => {
    mocks.dns.mx["motm.example"] = [{ exchange: "aspmx.l.google.com", priority: 1 }];
    mocks.dns.txt["motm.example"] = [["v=spf1 include:_spf.google.com ~all"]];
    mocks.dns.txt["google._domainkey.motm.example"] = [["v=DKIM1; k=rsa; p=MIIB"]];
    mocks.dns.txt["_dmarc.motm.example"] = [["v=DMARC1; p=none"]];
    const res = await api.call(admin, ws, "GET", "/connections/email/deliverability");
    expect(res.status).toBe(200);
    expect(res.body.domain).toBe("motm.example");
    expect(res.body.lines.map((l: { check: string; status: string }) => [l.check, l.status])).toEqual([
      ["mx", "green"],
      ["spf", "green"],
      ["dkim", "green"],
      ["dmarc", "amber"],
    ]);
    expect(res.body.lines[2].summary).toBe('DKIM key found at selector "google".');

    const selector = await api.call(admin, ws, "GET", "/connections/email/deliverability?selector=s1");
    expect(selector.body.lines[2]).toMatchObject({ status: "red", summary: "No DKIM key found (tried s1)." });
    expect((await api.call(admin, ws, "GET", "/connections/email/deliverability?selector=bad%20one")).status).toBe(400);
  });
});
