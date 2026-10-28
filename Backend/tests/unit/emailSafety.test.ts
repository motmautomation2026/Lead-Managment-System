import { describe, expect, it } from "vitest";
import { DEFAULT_SEND_WINDOW } from "../../src/domain/whatsappSafety.js";
import {
  buildFromName,
  classifySmtpError,
  connectionTestMessage,
  contactabilityForRejection,
  decideEmailSend,
  emailWarmupCap,
  htmlToText,
  isValidEmailAddress,
  listUnsubscribeHeader,
  messageIdFor,
  nextIstHour,
  pauseReasonFor,
  retryDelayMs,
  shouldAutoPauseEmail,
  warmupDayFor,
  type EmailSafetyInput,
} from "../../src/domain/emailSafety.js";

/** IST wall clock → Date ("2026-11-02T10:00" is a Monday). */
const ist = (local: string) => new Date(`${local}:00+05:30`);
const zero = () => 0;

const base = (over: Partial<EmailSafetyInput> = {}): EmailSafetyInput => ({
  source: "scheduled_action",
  now: ist("2026-11-02T10:00"),
  window: DEFAULT_SEND_WINDOW,
  dailyCap: 100,
  hourlyCap: 20,
  warmupDay: null,
  alreadyWarmed: false,
  sentToday: 0,
  sentThisHour: 0,
  paused: false,
  nextSendAt: null,
  random: zero,
  ...over,
});

describe("send window (rule 7)", () => {
  it("sends a workflow email inside the window", () => {
    expect(decideEmailSend(base())).toEqual({ send: true, spacingMs: 0 });
  });

  it("defers a workflow email on Sunday to Monday 09:30 plus jitter; a proposal email goes", () => {
    const sunday = ist("2026-11-01T12:00");
    expect(decideEmailSend(base({ now: sunday, random: () => 0.5 }))).toEqual({
      defer: new Date(ist("2026-11-02T09:30").getTime() + 10 * 60_000),
      reason: "Outside the email send window.",
    });
    for (const source of ["proposal", "meeting", "test"] as const) expect(decideEmailSend(base({ now: sunday, source }))).toMatchObject({ send: true });
  });

  it("Saturday 19:00 → Monday 09:30; 18:59 still sends", () => {
    expect(decideEmailSend(base({ now: ist("2026-11-07T19:00") }))).toMatchObject({ defer: ist("2026-11-09T09:30") });
    expect(decideEmailSend(base({ now: ist("2026-11-07T18:59") }))).toMatchObject({ send: true });
  });

  it("the AI agent is automated too", () => {
    expect(decideEmailSend(base({ source: "agent", now: ist("2026-11-02T08:00") }))).toMatchObject({ defer: ist("2026-11-02T09:30") });
  });
});

describe("caps and warm-up (rule 6)", () => {
  it("warm-up caps 20 / 40 / 70 on IST days 1–3 / 4–7 / 8–14, then the cap", () => {
    expect([1, 3, 4, 7, 8, 14, 15].map((d) => emailWarmupCap(d, 100, false))).toEqual([20, 20, 40, 40, 70, 70, 100]);
    expect(emailWarmupCap(2, 10, false)).toBe(10);
    expect(emailWarmupCap(null, 100, false)).toBe(100);
  });

  it("'already warmed' skips warm-up", () => {
    expect(emailWarmupCap(1, 100, true)).toBe(100);
    expect(decideEmailSend(base({ warmupDay: 2, alreadyWarmed: true, sentToday: 20 }))).toMatchObject({ send: true });
  });

  it("warm-up day 3 → 4 at IST midnight", () => {
    const savedAt = ist("2026-11-02T23:00");
    expect(warmupDayFor(savedAt, ist("2026-11-04T23:59"))).toBe(3);
    expect(warmupDayFor(savedAt, ist("2026-11-05T00:00"))).toBe(4);
    expect(decideEmailSend(base({ warmupDay: 3, sentToday: 20 }))).toMatchObject({ reason: "Warm-up daily cap (20) reached." });
    expect(decideEmailSend(base({ warmupDay: 4, sentToday: 20 }))).toMatchObject({ send: true });
  });

  it("over the daily cap defers to the next IST day's window", () => {
    expect(decideEmailSend(base({ sentToday: 100 }))).toEqual({ defer: ist("2026-11-03T09:30"), reason: "Daily cap (100) reached." });
    // A rep's email waits for the next day too (only the window is ignored).
    expect(decideEmailSend(base({ source: "proposal", sentToday: 100, now: ist("2026-11-02T23:50") }))).toMatchObject({ defer: ist("2026-11-03T09:30") });
  });

  it("the hourly cap defers to the next IST clock hour", () => {
    expect(decideEmailSend(base({ sentThisHour: 20, now: ist("2026-11-02T10:59") }))).toEqual({ defer: ist("2026-11-02T11:00"), reason: "Hourly cap (20) reached." });
    expect(decideEmailSend(base({ sentThisHour: 19 }))).toMatchObject({ send: true });
    // 18:30 → 19:00 is outside the window → Tuesday 09:30.
    expect(decideEmailSend(base({ sentThisHour: 20, now: ist("2026-11-02T18:30") }))).toMatchObject({ defer: ist("2026-11-03T09:30") });
    expect(decideEmailSend(base({ source: "proposal", sentThisHour: 20, now: ist("2026-11-02T18:30") }))).toMatchObject({ defer: ist("2026-11-02T19:00") });
  });

  it("IST hours turn at :30 UTC", () => {
    expect(nextIstHour(new Date("2026-11-02T04:29:00Z"))).toEqual(new Date("2026-11-02T04:30:00Z"));
    expect(nextIstHour(new Date("2026-11-02T04:30:00Z"))).toEqual(new Date("2026-11-02T05:30:00Z"));
  });
});

describe("spacing, pause, recipient", () => {
  it("waits ≤ 20 s inline, defers longer waits", () => {
    const now = ist("2026-11-02T10:00");
    expect(decideEmailSend(base({ nextSendAt: new Date(now.getTime() + 15_000) }))).toEqual({ send: true, spacingMs: 15_000 });
    expect(decideEmailSend(base({ nextSendAt: new Date(now.getTime() + 60_000) }))).toEqual({ defer: new Date(now.getTime() + 60_000), reason: "Spacing emails." });
  });

  it("paused defers every source, never fails", () => {
    expect(decideEmailSend(base({ paused: true, source: "proposal" }))).toMatchObject({ reason: "Email sending is paused." });
  });

  it("a recipient problem blocks (fails) before anything else", () => {
    expect(decideEmailSend(base({ paused: true, recipientProblem: "Contact is Do Not Contact." }))).toEqual({ block: "Contact is Do Not Contact." });
  });
});

describe("SMTP errors (rule 5)", () => {
  const smtp = (responseCode: number, response: string) => Object.assign(new Error(response), { responseCode, response });
  const net = (code: string) => Object.assign(new Error(code), { code });

  it.each([
    [smtp(550, "550 5.1.1 <x@y.com>: Recipient address rejected: User unknown"), "recipient_permanent"],
    [smtp(552, "552 5.2.2 Mailbox full"), "recipient_permanent"],
    [smtp(554, "554 5.7.1 Message rejected as spam"), "policy_blocked"],
    [smtp(535, "535 5.7.8 Username and Password not accepted"), "login_rejected"],
    [Object.assign(new Error("Invalid login"), { code: "EAUTH" }), "login_rejected"],
    [smtp(421, "421 4.7.0 Try again later, closing connection"), "rate_limited"],
    [smtp(451, "451 4.3.0 Temporary local problem"), "rate_limited"],
    [smtp(450, "450 4.7.1 Too many messages, slow down"), "rate_limited"],
    [smtp(450, "450 4.2.1 Mailbox busy"), "temporary"],
    [net("ETIMEDOUT"), "temporary"],
    [net("ECONNRESET"), "temporary"],
    [new Error("socket closed"), "temporary"],
  ])("%s → %s", (err, kind) => {
    expect(classifySmtpError(err)).toBe(kind);
  });

  it("5.1.x marks the contact invalid, other rejections permanent_bounce", () => {
    expect(contactabilityForRejection(smtp(550, "550 5.1.1 User unknown"))).toBe("invalid");
    expect(contactabilityForRejection(smtp(552, "552 5.2.2 Mailbox full"))).toBe("permanent_bounce");
  });

  it("pause reasons", () => {
    expect(pauseReasonFor("login_rejected", smtp(535, "535 5.7.8 nope"))).toBe("SMTP login rejected — check the password.");
    expect(pauseReasonFor("rate_limited", smtp(421, "421 4.7.0 Try again later"))).toBe("The mail server is limiting our sending: 421 4.7.0 Try again later");
  });

  it("backoff 5, 10, 20, 40 min", () => {
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n) / 60_000)).toEqual([5, 10, 20, 40]);
  });
});

describe("auto-pause (rule 8)", () => {
  it("5 temporary failures in 30 min", () => {
    expect(shouldAutoPauseEmail({ failures30m: 4, rejected24h: 0, sent24h: 0 })).toBeNull();
    expect(shouldAutoPauseEmail({ failures30m: 5, rejected24h: 0, sent24h: 0 })).toBe("5 email send failures in 30 minutes.");
  });

  it("≥ 5 % rejections only from 40 attempts", () => {
    expect(shouldAutoPauseEmail({ failures30m: 0, rejected24h: 3, sent24h: 36 })).toBeNull(); // 39 attempts
    expect(shouldAutoPauseEmail({ failures30m: 0, rejected24h: 2, sent24h: 38 })).toBe("2 of 40 emails were rejected by the recipient's server in 24 hours.");
    expect(shouldAutoPauseEmail({ failures30m: 0, rejected24h: 1, sent24h: 39 })).toBeNull(); // 2.5 %
  });
});

describe("message (rule 10)", () => {
  it("From name = owner | company for contacts, else the default", () => {
    expect(buildFromName("MOTM Sales", "Asha Rao", "MOTM Technologies")).toBe("Asha Rao | MOTM Technologies");
    expect(buildFromName("MOTM Sales", null, "MOTM Technologies")).toBe("MOTM Sales");
  });

  it("Message-ID on the from domain; List-Unsubscribe mailto", () => {
    expect(messageIdFor("motm.tech", "abc")).toBe("<abc@motm.tech>");
    expect(messageIdFor("motm.tech")).toMatch(/^<[0-9a-f-]{36}@motm\.tech>$/);
    expect(listUnsubscribeHeader("sales@motm.tech")).toBe("<mailto:sales@motm.tech?subject=unsubscribe>");
  });

  it("htmlToText keeps paragraphs, lists and link URLs", () => {
    const html = `<style>p{}</style><p>Hi Asha,</p><p>See <a href="https://motm.tech/x">our deck</a> &amp; reply.<br>Thanks</p><ul><li>One</li><li>Two</li></ul>`;
    expect(htmlToText(html)).toBe("Hi Asha,\nSee our deck (https://motm.tech/x) & reply.\nThanks\n\n- One\n- Two");
  });

  it("address syntax", () => {
    expect(isValidEmailAddress("asha@motm.tech")).toBe(true);
    for (const bad of ["asha", "asha@", "asha@motm", "a b@motm.tech", "<a@motm.tech>"]) expect(isValidEmailAddress(bad)).toBe(false);
  });
});

describe("connection test messages (rule 3)", () => {
  const ctx = { host: "smtp.example.com", port: 587, folder: "INBOX" };
  it.each([
    [Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }), /Couldn't find the server "smtp.example.com"/],
    [Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), /refused the connection on port 587/],
    [Object.assign(new Error("Greeting never received"), { code: "ETIMEDOUT" }), /didn't answer within 15 seconds/],
    [Object.assign(new Error("routines:ssl3_get_record:wrong version number"), { code: "ESOCKET" }), /secure connection failed/],
    [Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 }), /app password/],
    [Object.assign(new Error("Command failed"), { authenticationFailed: true }), /app password/],
    [Object.assign(new Error("Command failed"), { serverResponseCode: "NONEXISTENT" }), /The folder "INBOX" doesn't exist/],
  ])("%s", (err, text) => {
    expect(connectionTestMessage(err, ctx)).toMatch(text);
  });
});
