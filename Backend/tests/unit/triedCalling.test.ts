import { describe, expect, it } from "vitest";
import { MAX_TRIED_CALLING_MESSAGES, triedCallingCheck, type TriedCallingInput } from "../../src/domain/callAttempts.js";
import { decideSend, DEFAULT_SEND_WINDOW, OPT_OUT_LINE, type SafetyInput } from "../../src/domain/whatsappSafety.js";
import { safetySourceOf, sourceColumn } from "../../src/providers/baileys.manager.js";
import { ENQUEUE_SQL, FACTS_SQL } from "../../src/services/triedCalling.service.js";
import { RESTART_AT_SQL } from "../../src/services/agentWakeups.service.js";
import { WORKER_LOOPS } from "../../src/services/systemHealth.service.js";

const ist = (local: string) => new Date(`${local}:00+05:30`);

describe("LL-3 'We tried calling' WhatsApp — send-time check", () => {
  const ok: TriedCallingInput = { enabled: true, automated: true, hasPhone: true, lifecycle: "active", reached: false, touches7d: 0, max7d: 2, triedCallingSent: 0 };
  it("sends for a live lead with room in the limits", () => {
    expect(triedCallingCheck(ok)).toBeNull();
    expect(triedCallingCheck({ ...ok, lifecycle: "long_term_nurture", touches7d: 1, triedCallingSent: 2 })).toBeNull();
  });
  it("dropped: setting off, reached meanwhile, closed lead, no phone", () => {
    expect(triedCallingCheck({ ...ok, enabled: false })).toMatch(/turned off/);
    expect(triedCallingCheck({ ...ok, automated: false })).toBe("Automation is off for this contact.");
    expect(triedCallingCheck({ ...ok, reached: true })).toMatch(/reached meanwhile/);
    expect(triedCallingCheck({ ...ok, lifecycle: "do_not_contact" })).toMatch(/do not contact/);
    expect(triedCallingCheck({ ...ok, lifecycle: "lost" })).toMatch(/lost/);
    expect(triedCallingCheck({ ...ok, hasPhone: false })).toMatch(/phone/);
  });
  it("counts toward 2 per week; its own cap of 3 per lead replaces the 8-total limit (no 48 h gap input at all)", () => {
    expect(triedCallingCheck({ ...ok, touches7d: 2 })).toMatch(/2 messages in 7 days/);
    expect(triedCallingCheck({ ...ok, triedCallingSent: 3 })).toMatch(/3 "We tried calling" messages/);
  });

  /** One unanswered call a day at 11:00 IST; `aiSends` = earlier AI send times. Returns the tried-calling send times. */
  const simulate = (days: string[], aiSends: Date[] = []) => {
    const sent: Date[] = [];
    for (const day of days) {
      const now = ist(`${day}T11:00`);
      const weekAgo = now.getTime() - 7 * 86_400_000;
      const touches7d = [...aiSends, ...sent].filter((t) => t.getTime() > weekAgo && t <= now).length;
      if (!triedCallingCheck({ ...ok, touches7d, triedCallingSent: sent.length })) sent.push(now);
    }
    return sent;
  };
  it("5 unanswered calls on 5 days (spread over weeks) → at most 3 messages", () => {
    expect(MAX_TRIED_CALLING_MESSAGES).toBe(3);
    expect(simulate(["2026-11-02", "2026-11-10", "2026-11-18", "2026-11-26", "2026-12-04"])).toHaveLength(3);
    // On 5 consecutive days the 2-per-week limit drops it earlier.
    expect(simulate(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"])).toHaveLength(2);
  });
  it("2 per week is shared with AI sends", () => {
    expect(simulate(["2026-11-18"], [ist("2026-11-16T10:00"), ist("2026-11-17T10:00")])).toHaveLength(0);
    expect(simulate(["2026-11-18", "2026-11-19"], [ist("2026-11-17T10:00")])).toHaveLength(1);
  });
});

describe("LL-3 'We tried calling' — WhatsApp safety rules", () => {
  const base: SafetyInput = {
    source: safetySourceOf({ type: "tried_calling", id: "t1" }),
    now: ist("2026-11-17T11:00"),
    window: DEFAULT_SEND_WINDOW,
    dailyCap: 100,
    warmupDay: null,
    sentToday: 0,
    maxNewChatsPerDay: 20,
    newChatsToday: 0,
    isFirstMessage: false,
    text: "Hi Asha, this is Ravi from Northbeam. I tried calling you just now. When is a good time to talk? You can also reply here.",
    paused: false,
    nextSendAt: null,
    random: () => 0,
  };
  it("is its own source column and an automated safety source", () => {
    expect(sourceColumn({ type: "tried_calling", id: "t1" })).toBe("tried_calling_id");
    expect(base.source).toBe("tried_calling");
  });
  it("waits for the send window (Saturday evening → Monday 09:30)", () => {
    expect(decideSend({ ...base, now: ist("2026-11-21T20:00") })).toEqual({ defer: ist("2026-11-23T09:30"), reason: "Outside the WhatsApp send window." });
  });
  it("a paused number, the daily cap and spacing defer it", () => {
    expect(decideSend({ ...base, paused: true })).toMatchObject({ reason: "WhatsApp sending is paused." });
    expect(decideSend({ ...base, sentToday: 100 })).toMatchObject({ reason: "Daily cap (100) reached." });
    expect(decideSend({ ...base, nextSendAt: new Date(base.now.getTime() + 60_000) })).toMatchObject({ reason: "Spacing WhatsApp sends." });
  });
  it("a first WhatsApp to the lead is allowed (no link) and gets the opt-out line", () => {
    const first = decideSend({ ...base, isFirstMessage: true });
    expect("send" in first && first.text.endsWith(OPT_OUT_LINE)).toBe(true);
  });
});

describe("LL-3 SQL guards", () => {
  it("queues once per lead per IST day, never for an opted-out / DNC number or with the setting off", () => {
    expect(ENQUEUE_SQL).toMatch(/on conflict \(lead_id, ist_day\) do nothing/);
    expect(ENQUEUE_SQL).toMatch(/'opted_out', 'invalid', 'do_not_contact'/);
    expect(ENQUEUE_SQL).toMatch(/tried_calling_whatsapp_enabled/);
    expect(FACTS_SQL).toMatch(/k\.connected and k\.created_at > t\.created_at/);
  });
  it("AI wake-ups never before the interested-later restart date (09:30 IST)", () => {
    expect(RESTART_AT_SQL).toMatch(/interested_later_restart_at \+ time '09:30'\) at time zone 'Asia\/Kolkata'/);
  });
  it("the worker step has a heartbeat loop", () => {
    expect(WORKER_LOOPS.tried_calling_whatsapp.critical).toBe(true);
  });
});
