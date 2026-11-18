import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../../src/dto.js";
import type { Mailbox } from "../../src/services/emailConnection.service.js";
import type { EmailTransport, OutgoingMail } from "../../src/providers/email.provider.js";
import {
  CLAIM_ALERTS_SQL,
  CLAIM_DIGEST_SQL,
  DIGEST_CANDIDATES_SQL,
  MARK_ALERTS_SQL,
  runMorningDigest,
  runStaffAlertEmails,
  WARN_NO_MAILBOX_SQL,
} from "../../src/services/staffAlerts.service.js";
import { alertEmail, digestEmail, digestWindowOpen } from "../../src/domain/staffEmail.js";

const ist = (local: string) => new Date(`${local}:00+05:30`);
const NOW = ist("2026-11-17T10:00");
const BOX = { fromName: "MOTM", fromAddress: "crm@motm.example", replyTo: "crm@motm.example", transportKey: "k", smtp: {} } as unknown as Mailbox;

const alert = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  workspace_id: "ws-1",
  recipient_id: "u1",
  title: "WhatsApp reply received",
  detail: "Automation was switched to manual.",
  href: "/leads/lead-1",
  created_at: ist("2026-11-17T09:58"),
  email: "ravi@motm.example",
  full_name: "Ravi Kumar",
  wants_email: true,
  ...over,
});

function fakeDb(claimed: unknown[], digest: unknown[] = [], digestClaim = 1) {
  const marks: { ids: string[]; status: string }[] = [];
  const queries: string[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push(sql);
      if (sql === CLAIM_ALERTS_SQL) return { rows: claimed };
      if (sql === MARK_ALERTS_SQL) {
        marks.push({ ids: params[0] as string[], status: params[1] as string });
        return { rows: [], rowCount: 1 };
      }
      if (sql === WARN_NO_MAILBOX_SQL) return { rows: [], rowCount: 1 };
      if (sql === DIGEST_CANDIDATES_SQL) return { rows: digest };
      if (sql === CLAIM_DIGEST_SQL) return { rows: [], rowCount: digestClaim };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  } as unknown as Queryable;
  return { db, marks, queries };
}

function fakeTransport() {
  const sent: OutgoingMail[] = [];
  const transport: EmailTransport = { sendMail: async (m) => (sent.push(m), { response: "250 OK" }), verify: async () => true, close: () => undefined };
  return { sent, transport: () => transport };
}

describe("LL-2 staff alert emails", () => {
  it("batched: one email per person per tick, plain + HTML, links, no unsubscribe header, never the lead email queue", async () => {
    const f = fakeDb([alert(), alert({ id: "n2", title: "Overdue: Call back — Ravi", detail: null, href: "/contacts/lead-2" })]);
    const t = fakeTransport();
    expect(await runStaffAlertEmails({ db: f.db, now: NOW, baseUrl: "https://crm.example.com", mailbox: async () => BOX, transport: t.transport })).toBe(1);
    expect(t.sent).toHaveLength(1);
    const mail = t.sent[0]!;
    expect(mail.to).toBe("ravi@motm.example");
    expect(mail.subject).toBe("MOTM Flow: 2 urgent alerts");
    expect(mail.text).toContain("• WhatsApp reply received\n  Automation was switched to manual.\n  https://crm.example.com/leads/lead-1");
    expect(mail.html).toContain('<a href="https://crm.example.com/contacts/lead-2">');
    expect(mail.headers).toEqual({});
    expect(f.marks).toEqual([{ ids: ["n1", "n2"], status: "sent" }]);
    expect(f.queries.some((q) => q.includes("email_outbound_messages") || q.includes("message_facts") || q.includes("timeline_events"))).toBe(false);
  });

  it("toggle off → bell only (skipped), nothing sent", async () => {
    const f = fakeDb([alert({ wants_email: false })]);
    const t = fakeTransport();
    expect(await runStaffAlertEmails({ db: f.db, now: NOW, mailbox: async () => BOX, transport: t.transport })).toBe(0);
    expect(t.sent).toEqual([]);
    expect(f.marks).toEqual([{ ids: ["n1"], status: "skipped" }]);
  });

  it("no mailbox → bell only + the one-time admin warning", async () => {
    const f = fakeDb([alert()]);
    expect(await runStaffAlertEmails({ db: f.db, now: NOW, mailbox: async () => null })).toBe(0);
    expect(f.queries).toContain(WARN_NO_MAILBOX_SQL);
    expect(WARN_NO_MAILBOX_SQL).toContain("where not exists (select 1 from public.system_health_alerts where workspace_id = $1 and problem = 'staff_email_no_mailbox')");
    expect(f.marks).toEqual([{ ids: ["n1"], status: "skipped" }]);
  });

  it("WORKER_DRY_RUN → logged, never sent", async () => {
    const f = fakeDb([alert()]);
    const t = fakeTransport();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runStaffAlertEmails({ db: f.db, now: NOW, dryRun: true, mailbox: async () => BOX, transport: t.transport });
    log.mockRestore();
    expect(t.sent).toEqual([]);
    expect(f.marks).toEqual([{ ids: ["n1"], status: "skipped" }]);
  });

  it("an alert older than a day is skipped; an SMTP error marks failed", async () => {
    const f = fakeDb([alert({ created_at: ist("2026-11-15T09:00") })]);
    await runStaffAlertEmails({ db: f.db, now: NOW, mailbox: async () => BOX, transport: fakeTransport().transport });
    expect(f.marks).toEqual([{ ids: ["n1"], status: "skipped" }]);
    const g = fakeDb([alert()]);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing: EmailTransport = { sendMail: async () => Promise.reject(Object.assign(new Error("x"), { code: "EAUTH" })), verify: async () => true, close: () => undefined };
    await runStaffAlertEmails({ db: g.db, now: NOW, mailbox: async () => BOX, transport: () => failing });
    err.mockRestore();
    expect(g.marks).toEqual([{ ids: ["n1"], status: "failed" }]);
  });

  it("the claim: pending only, fair across workspaces, skip locked, the login email and both toggles", () => {
    expect(CLAIM_ALERTS_SQL).toContain("x.email_status = 'pending'");
    expect(CLAIM_ALERTS_SQL).toContain("for update skip locked");
    expect(CLAIM_ALERTS_SQL).toContain("p.is_active and p.email_alerts_enabled as wants_email");
  });
});

describe("LL-2 morning digest", () => {
  const row = { workspace_id: "ws-1", user_id: "u1", email: "ravi@motm.example", full_name: "Ravi Kumar", workspace_name: "MOTM", calls: 3, replies: 2, meetings: 1, next_steps: 0, overdue: 4 };

  it("09:00–12:00 IST, Monday–Saturday only", () => {
    expect(digestWindowOpen(ist("2026-11-17T08:59"))).toBe(false);
    expect(digestWindowOpen(ist("2026-11-17T09:00"))).toBe(true);
    expect(digestWindowOpen(ist("2026-11-17T12:00"))).toBe(false);
    expect(digestWindowOpen(ist("2026-11-15T10:00"))).toBe(false); // Sunday
  });

  it("outside the window nothing is read", async () => {
    const f = fakeDb([], [row]);
    expect(await runMorningDigest({ db: f.db, now: ist("2026-11-17T08:00") })).toBe(0);
    expect(f.queries).toEqual([]);
  });

  it("sends once per member per day; an empty digest is claimed but not sent", async () => {
    const t = fakeTransport();
    const f = fakeDb([], [row, { ...row, user_id: "u2", calls: 0, replies: 0, meetings: 0, overdue: 0 }]);
    expect(await runMorningDigest({ db: f.db, now: NOW, baseUrl: "https://crm.example.com", mailbox: async () => BOX, transport: t.transport })).toBe(1);
    expect(t.sent.map((m) => m.subject)).toEqual(["MOTM Flow: your day — 3 calls, 2 replies, 1 meeting"]);
    expect(f.queries.filter((q) => q === CLAIM_DIGEST_SQL)).toHaveLength(2);
    const again = fakeDb([], [row], 0);
    expect(await runMorningDigest({ db: again.db, now: NOW, mailbox: async () => BOX, transport: t.transport })).toBe(0);
  });

  it("the candidates: active members with the digest on, not sent today, only active / nurture leads", () => {
    expect(DIGEST_CANDIDATES_SQL).toContain("p.is_active and p.email_digest_enabled");
    expect(DIGEST_CANDIDATES_SQL).toContain("m.digest_sent_on < $4::date");
    expect(DIGEST_CANDIDATES_SQL).toContain("l.lifecycle_state in ('active', 'long_term_nurture')");
  });
});

describe("LL-2 staff email texts", () => {
  it("one alert → its title as the subject; no base URL → no links", () => {
    const mail = alertEmail("Ravi Kumar", [{ title: "New website lead — call within 1 working hour", detail: null, href: "/leads/x" }], "");
    expect(mail.subject).toBe("MOTM Flow: New website lead — call within 1 working hour");
    expect(mail.text).toBe(
      'Hi Ravi,\n\n• New website lead — call within 1 working hour\n\nYou get these because "Email me urgent alerts" is on (MOTM Flow → Settings → My profile).',
    );
  });

  it("digest: nothing open → null", () => {
    expect(digestEmail("Ravi", "MOTM", { calls: 0, replies: 0, meetings: 0, nextSteps: 0, overdue: 0 }, "")).toBeNull();
  });
});
