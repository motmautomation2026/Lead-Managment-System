import { describe, expect, it } from "vitest";
import { sendRecheck, type SendRecheckInput } from "../../src/agent/liveMode.js";
import type { AgentRuleSettings } from "../../src/agent/rules.js";
import {
  addWorkingTime,
  contactSendProblem,
  draftSkipReason,
  escalationDue,
  replySendAt,
  replySendProblem,
  type ContactSendState,
  type DraftEligibilityInput,
} from "../../src/domain/replyDrafts.js";
import { DEFAULT_SEND_WINDOW } from "../../src/domain/whatsappSafety.js";

const ist = (local: string) => new Date(`${local}:00+05:30`);
const HOUR = 3_600_000;
const WEDNESDAY_11 = ist("2026-11-04T11:00");

const wa: ContactSendState = { channel: "whatsapp", lifecycleState: "active", channelStatus: "reachable", phoneStatus: null, address: "+919000000001" };
const mail: ContactSendState = { channel: "email", lifecycleState: "active", channelStatus: null, address: "raj@example.com" };
const limits = { whatsapp_max_words: 60, email_max_words: 120 };

const eligible = (over: Partial<DraftEligibilityInput> = {}): DraftEligibilityInput => ({
  ...wa,
  label: "question",
  mode: "shadow",
  spentUsd: 1,
  budgetUsd: 20,
  decisionsToday: 3,
  maxDecisionsPerDay: 50,
  hasOwner: true,
  ...over,
});

describe("draftSkipReason (rules 1 + 3)", () => {
  it.each(["positive", "question", "other", "unclassified"] as const)("%s gets a draft", (label) => expect(draftSkipReason(eligible({ label }))).toBeNull());
  it.each(["asked_to_stop", "not_interested", "annoyed"] as const)("%s never does", (label) => expect(draftSkipReason(eligible({ label }))).toBe(`label ${label}`));
  it("not while the label is unknown, the agent is off, the budget or the daily cap is used up, or there is no owner", () => {
    expect(draftSkipReason(eligible({ label: null }))).toBe("label none");
    expect(draftSkipReason(eligible({ mode: "off" }))).toBe("agent off");
    expect(draftSkipReason(eligible({ spentUsd: 20 }))).toBe("monthly budget reached");
    expect(draftSkipReason(eligible({ decisionsToday: 50 }))).toBe("daily decision limit reached");
    expect(draftSkipReason(eligible({ hasOwner: false }))).toBe("no owner");
  });
  it("not for Do Not Contact or an opted-out channel", () => {
    expect(draftSkipReason(eligible({ lifecycleState: "do_not_contact" }))).toBe("The contact is Do Not Contact.");
    expect(draftSkipReason(eligible({ channelStatus: "opted_out" }))).toBe("The contact opted out of WhatsApp.");
    expect(draftSkipReason(eligible({ ...mail, channelStatus: "unsubscribed" }))).toBe("The contact unsubscribed from email.");
  });
});

describe("replySendProblem (rule 4)", () => {
  const settings: AgentRuleSettings = {
    send_days: [1, 2, 3, 4, 5, 6],
    send_window_start: "09:30:00",
    send_window_end: "19:00:00",
    min_gap_hours: 48,
    max_touches_7d: 2,
    max_touches_total: 8,
    email_max_words: 120,
    whatsapp_max_words: 60,
    wake_min_days: 1,
    rep_quiet_hours: 0,
  } as AgentRuleSettings;

  it("is exempt from the AI's 48 h gap / 2 per week / 8 total limits: the same contact the AI may not message gets the rep's reply", () => {
    const touches = Array.from({ length: 8 }, (_, i) => new Date(WEDNESDAY_11.getTime() - (i + 1) * HOUR));
    const atLimits: SendRecheckInput = {
      now: WEDNESDAY_11,
      channel: "whatsapp",
      decisionCreatedAt: WEDNESDAY_11,
      mode: "live",
      lead: { agentStatus: "active", lifecycleState: "active", email: null, phoneE164: wa.address },
      contactability: { email: null, whatsapp: "reachable", phone: null } as SendRecheckInput["contactability"],
      nurtureLongTerm: false,
      lastReplyAt: null,
      imapLastSuccessAt: null,
      hasActiveWorkflowRun: false,
      settings,
      realTouchCount: 8,
      lastRealTouchAt: touches[0]!,
      recentRealTouchTimes: touches,
      lastRepActivityAt: null,
    };
    expect(sendRecheck(atLimits)).not.toEqual({ ok: true });
    expect(replySendProblem(wa, "Happy to help. Would Thursday or Friday suit you for a short call?", limits)).toBeNull();
  });

  it("opt-out, DNC and a bad channel status still block", () => {
    const body = "Thanks, Raj.";
    expect(replySendProblem({ ...wa, channelStatus: "opted_out" }, body, limits)).toBe("The contact opted out of WhatsApp.");
    expect(replySendProblem({ ...wa, lifecycleState: "do_not_contact" }, body, limits)).toBe("The contact is Do Not Contact.");
    expect(replySendProblem({ ...wa, phoneStatus: "wrong_number" }, body, limits)).toBe("The contact's phone status is wrong number.");
    expect(replySendProblem({ ...mail, channelStatus: "permanent_bounce" }, body, limits)).toBe("The contact's email status is permanent bounce.");
    expect(replySendProblem({ ...wa, address: null }, body, limits)).toBe("The contact has no WhatsApp number.");
  });

  it("the channel word limit applies to the rep's text (60 WhatsApp / 120 email)", () => {
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    expect(replySendProblem(wa, words(60), limits)).toBeNull();
    expect(replySendProblem(wa, words(61), limits)).toBe("WhatsApp replies can be at most 60 words; this one has 61.");
    expect(replySendProblem(mail, words(121), limits)).toBe("Email replies can be at most 120 words; this one has 121.");
    expect(replySendProblem(wa, "   ", limits)).toBe("The reply is empty.");
  });

  it("contactSendProblem allows a reachable contact", () => expect(contactSendProblem(mail)).toBeNull());
});

describe("working hours (rule 5)", () => {
  it("inside the window: now; outside: the next opening (Sunday → Monday 09:30)", () => {
    expect(replySendAt(WEDNESDAY_11, DEFAULT_SEND_WINDOW)).toEqual(WEDNESDAY_11);
    expect(replySendAt(ist("2026-11-08T20:00"), DEFAULT_SEND_WINDOW)).toEqual(ist("2026-11-09T09:30"));
  });

  it("adds working time inside the window only", () => {
    expect(addWorkingTime(WEDNESDAY_11, 2 * HOUR, DEFAULT_SEND_WINDOW)).toEqual(ist("2026-11-04T13:00"));
    // 18:00 → 1 h today (to 19:00), 1 h tomorrow from 09:30.
    expect(addWorkingTime(ist("2026-11-04T18:00"), 2 * HOUR, DEFAULT_SEND_WINDOW)).toEqual(ist("2026-11-05T10:30"));
    // Saturday 18:30 → 30 min, Sunday is off, Monday 09:30 + 1 h 30.
    expect(addWorkingTime(ist("2026-11-07T18:30"), 2 * HOUR, DEFAULT_SEND_WINDOW)).toEqual(ist("2026-11-09T11:00"));
    // Before opening: from 09:30.
    expect(addWorkingTime(ist("2026-11-04T07:00"), 2 * HOUR, DEFAULT_SEND_WINDOW)).toEqual(ist("2026-11-04T11:30"));
  });

  it("escalationDue only after 2 working hours", () => {
    const created = ist("2026-11-04T18:00");
    expect(escalationDue(created, ist("2026-11-05T10:29"), DEFAULT_SEND_WINDOW)).toBe(false);
    expect(escalationDue(created, ist("2026-11-05T10:30"), DEFAULT_SEND_WINDOW)).toBe(true);
    expect(escalationDue(ist("2026-11-08T20:00"), ist("2026-11-09T09:00"), DEFAULT_SEND_WINDOW)).toBe(false);
  });
});
