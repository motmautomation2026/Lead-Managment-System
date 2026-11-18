import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEND_WINDOW,
  FIRST_MESSAGE_LINK_REASON,
  decideSend,
  ensureOptOutLine,
  hasLink,
  nextDayWindowTime,
  nextWindowTime,
  shouldAutoPause,
  typingMsFor,
  warmupCap,
  warmupDayFor,
  type SafetyInput,
} from "../../src/domain/whatsappSafety.js";

/** IST wall clock → Date ("2026-11-02T10:00" is a Monday). */
const ist = (local: string) => new Date(`${local}:00+05:30`);
const zero = () => 0;

const base = (over: Partial<SafetyInput> = {}): SafetyInput => ({
  source: "scheduled_action",
  now: ist("2026-11-02T10:00"),
  window: DEFAULT_SEND_WINDOW,
  dailyCap: 200,
  warmupDay: null,
  sentToday: 0,
  maxNewChatsPerDay: 20,
  newChatsToday: 0,
  isFirstMessage: false,
  text: "Hello",
  paused: false,
  nextSendAt: null,
  random: zero,
  ...over,
});

describe("send window (rule 5)", () => {
  it("sends inside the window", () => {
    expect(decideSend(base())).toMatchObject({ send: true });
  });

  it("defers a workflow send on Sunday to Monday 09:30 plus jitter", () => {
    const decision = decideSend(base({ now: ist("2026-11-01T12:00"), random: () => 0.5 }));
    expect(decision).toEqual({ defer: new Date(ist("2026-11-02T09:30").getTime() + 10 * 60_000), reason: "Outside the WhatsApp send window." });
  });

  it("Saturday 19:00 (end is exclusive) → Monday 09:30", () => {
    expect(nextWindowTime(ist("2026-11-07T19:00"), DEFAULT_SEND_WINDOW, zero)).toEqual(ist("2026-11-09T09:30"));
    expect(nextWindowTime(ist("2026-11-07T18:59"), DEFAULT_SEND_WINDOW, zero)).toEqual(ist("2026-11-07T18:59"));
  });

  it("before opening → the same day's opening", () => {
    expect(nextWindowTime(ist("2026-11-03T08:00"), DEFAULT_SEND_WINDOW, zero)).toEqual(ist("2026-11-03T09:30"));
  });

  it("jitter stays within 0–20 minutes", () => {
    const t = nextWindowTime(ist("2026-11-03T08:00"), DEFAULT_SEND_WINDOW, () => 0.999999).getTime() - ist("2026-11-03T09:30").getTime();
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(20 * 60_000);
  });

  it.each(["proposal", "meeting"] as const)("does not hold a rep's %s message", (source) => {
    expect(decideSend(base({ source, now: ist("2026-11-01T23:00") }))).toMatchObject({ send: true });
  });

  it("holds the AI agent like a workflow", () => {
    expect(decideSend(base({ source: "agent", now: ist("2026-11-01T12:00") }))).toHaveProperty("defer");
  });
});

describe("caps (rules 3, 4)", () => {
  it.each([
    [1, 20],
    [3, 20],
    [4, 40],
    [7, 40],
    [8, 80],
    [14, 80],
    [15, 200],
    [null, 200],
  ])("warm-up day %s → cap %s", (day, cap) => {
    expect(warmupCap(day, 200)).toBe(cap);
  });

  it("warm-up never raises a lower configured cap", () => {
    expect(warmupCap(2, 10)).toBe(10);
  });

  it("counts warm-up days on IST calendar days (day 3 → 4 at IST midnight)", () => {
    const paired = ist("2026-11-02T23:30");
    expect(warmupDayFor(paired, ist("2026-11-02T23:59"))).toBe(1);
    expect(warmupDayFor(paired, ist("2026-11-03T00:00"))).toBe(2);
    expect(warmupDayFor(paired, ist("2026-11-04T23:59"))).toBe(3);
    expect(warmupDayFor(paired, ist("2026-11-05T00:00"))).toBe(4);
    expect(warmupDayFor(null, ist("2026-11-05T00:00"))).toBeNull();
  });

  it("defers at the warm-up cap to the next day's window", () => {
    const decision = decideSend(base({ warmupDay: 2, sentToday: 20 }));
    expect(decision).toEqual({ defer: ist("2026-11-03T09:30"), reason: "Warm-up daily cap (20) reached." });
  });

  it("defers at the configured cap", () => {
    expect(decideSend(base({ sentToday: 200 }))).toMatchObject({ reason: "Daily cap (200) reached." });
  });

  it("next day after Saturday is Monday", () => {
    expect(nextDayWindowTime(ist("2026-11-07T11:00"), DEFAULT_SEND_WINDOW, zero)).toEqual(ist("2026-11-09T09:30"));
  });

  it("a rep's message over the cap also waits for the next day's window", () => {
    expect(decideSend(base({ source: "proposal", sentToday: 200 }))).toMatchObject({ defer: ist("2026-11-03T09:30") });
  });

  it("the 21st first message of the day defers; a reply to a known contact does not", () => {
    expect(decideSend(base({ isFirstMessage: true, newChatsToday: 20 }))).toMatchObject({ reason: "New-chat limit (20 per day) reached." });
    expect(decideSend(base({ isFirstMessage: false, newChatsToday: 20 }))).toMatchObject({ send: true });
    expect(decideSend(base({ isFirstMessage: true, newChatsToday: 19 }))).toMatchObject({ send: true });
  });
});

describe("first message (rule 6)", () => {
  it.each([
    "See https://acme.com",
    "see http://x.io",
    "www.acme.in",
    "chat on wa.me/919999999999",
    "bit.ly/abc",
    "Visit acme.com/offer today",
    "acme.co.in",
    "WWW.ACME.COM",
  ])("finds a link in %j", (text) => {
    expect(hasLink(text)).toBe(true);
  });

  it.each(["Mail me at asha@acme.com", "Rs.500 off", "e.g. our plan", "Hello there."])("no link in %j", (text) => {
    expect(hasLink(text)).toBe(false);
  });

  it("blocks an automated first message with a link", () => {
    expect(decideSend(base({ isFirstMessage: true, text: "Hi, see https://acme.com" }))).toEqual({ block: FIRST_MESSAGE_LINK_REASON });
  });

  it("allows a link in a later message or in a rep's message", () => {
    expect(decideSend(base({ text: "https://acme.com" }))).toMatchObject({ send: true, text: "https://acme.com" });
    expect(decideSend(base({ source: "proposal", isFirstMessage: true, text: "https://acme.com" }))).toMatchObject({ send: true });
  });

  it("appends the opt-out line once", () => {
    expect(ensureOptOutLine("Hi")).toBe("Hi\n\nReply STOP to opt out.");
    expect(ensureOptOutLine("Hi\n\nReply STOP to opt out.")).toBe("Hi\n\nReply STOP to opt out.");
    expect(ensureOptOutLine(ensureOptOutLine("Hi"))).toBe("Hi\n\nReply STOP to opt out.");
    expect(decideSend(base({ isFirstMessage: true, text: "Hi" }))).toMatchObject({ text: "Hi\n\nReply STOP to opt out." });
    expect(decideSend(base({ isFirstMessage: false, text: "Hi" }))).toMatchObject({ text: "Hi" });
  });
});

describe("pause, spacing and typing", () => {
  it("paused sends defer, never fail", () => {
    expect(decideSend(base({ paused: true, source: "proposal" }))).toMatchObject({ reason: "WhatsApp sending is paused." });
  });

  it("waits inline for short spacing, defers long spacing to next_send_at", () => {
    const now = ist("2026-11-02T10:00");
    expect(decideSend(base({ nextSendAt: new Date(now.getTime() + 5_000) }))).toMatchObject({ send: true, spacingMs: 5_000 });
    const later = new Date(now.getTime() + 90_000);
    expect(decideSend(base({ nextSendAt: later }))).toEqual({ defer: later, reason: "Spacing WhatsApp sends." });
    expect(decideSend(base({ nextSendAt: new Date(now.getTime() - 1) }))).toMatchObject({ spacingMs: 0 });
  });

  it("typing lasts 2–8 s and grows with length", () => {
    expect(typingMsFor("hi", () => 0)).toBe(2_000);
    expect(typingMsFor("x".repeat(100), () => 0.5)).toBe(6_000);
    expect(typingMsFor("x".repeat(1000), () => 1)).toBe(8_000);
  });
});

describe("shouldAutoPause (rule 7)", () => {
  const quiet = { failures30m: 0, reconnectFailures30m: 0, stops24h: 0, sends24h: 0 };

  it("is null when quiet", () => {
    expect(shouldAutoPause(quiet)).toBeNull();
    expect(shouldAutoPause({ ...quiet, failures30m: 4, reconnectFailures30m: 4, stops24h: 2, sends24h: 100 })).toBeNull();
  });

  it("pauses on 5 failures or 5 failed reconnects in 30 min", () => {
    expect(shouldAutoPause({ ...quiet, failures30m: 5 })).toMatch(/5 WhatsApp send failures/);
    expect(shouldAutoPause({ ...quiet, reconnectFailures30m: 5 })).toMatch(/failed reconnects/);
  });

  it("pauses on 3 STOPs in 24 h", () => {
    expect(shouldAutoPause({ ...quiet, stops24h: 3 })).toMatch(/3 contacts asked us to stop/);
  });

  it("pauses at 5 % STOPs only with at least 40 sends", () => {
    expect(shouldAutoPause({ ...quiet, stops24h: 2, sends24h: 40 })).toMatch(/2 of 40/);
    expect(shouldAutoPause({ ...quiet, stops24h: 2, sends24h: 41 })).toBeNull();
    expect(shouldAutoPause({ ...quiet, stops24h: 2, sends24h: 39 })).toBeNull();
    expect(shouldAutoPause({ ...quiet, stops24h: 1, sends24h: 10 })).toBeNull();
  });
});
