import { describe, expect, it } from "vitest";
import {
  EMAIL_NO_REPLY_READING,
  canSetScope,
  effectiveMode,
  liveChannels,
  sendRecheck,
  type LiveScope,
  type SendRecheckInput,
} from "../../src/agent/liveMode.js";
import { countQuestions } from "../../src/agent/messageChecks.js";
import { goLiveReadiness } from "../../src/agent/readiness.js";
import { validateDecision, type AgentRuleSettings, type RulesContext } from "../../src/agent/rules.js";

/** Asia/Kolkata wall-clock time → Date. */
const ist = (local: string) => new Date(`${local}:00+05:30`);
const MIN = 60_000;
const HOUR = 60 * MIN;
// A Wednesday inside the 09:30–19:00 window.
const NOW = ist("2026-10-28T12:00");

const settings: AgentRuleSettings = {
  send_days: [1, 2, 3, 4, 5, 6],
  send_window_start: "09:30:00",
  send_window_end: "19:00:00",
  min_gap_hours: 48,
  max_touches_7d: 2,
  max_touches_total: 8,
  email_max_words: 250,
  whatsapp_max_words: 80,
  wake_min_days: 1,
  wake_max_days: 30,
  nurture_long_term: false,
  rep_quiet_hours: 24,
};

describe("effectiveMode (rule 2)", () => {
  const liveSince = ist("2026-10-20T10:00");
  const before = new Date(liveSince.getTime() - MIN);
  const after = new Date(liveSince.getTime() + MIN);
  const live = (scope: LiveScope) => ({ mode: "live" as const, live_scope: scope, live_since: scope === "new_leads" ? liveSince : null });

  it("off and shadow workspaces keep their mode, marked or not", () => {
    for (const mode of ["off", "shadow"] as const) {
      expect(effectiveMode({ mode, live_scope: "all", live_since: null }, { agentLiveTest: true, createdAt: after })).toBe(mode);
    }
  });

  it.each([
    // scope, marked, created after live_since, expected
    ["test_contacts", true, false, "live"],
    ["test_contacts", false, true, "shadow"],
    ["test_contacts", false, false, "shadow"],
    ["new_leads", false, true, "live"],
    ["new_leads", false, false, "shadow"],
    ["new_leads", true, false, "live"],
    ["all", false, false, "live"],
    ["all", true, true, "live"],
  ] as const)("%s, marked %s, created after %s → %s", (scope, marked, createdAfter, expected) => {
    expect(effectiveMode(live(scope), { agentLiveTest: marked, createdAt: createdAfter ? after : before })).toBe(expected);
  });

  it("a contact created exactly at live_since is live; new_leads without live_since is nobody", () => {
    expect(effectiveMode(live("new_leads"), { agentLiveTest: false, createdAt: liveSince })).toBe("live");
    expect(effectiveMode({ mode: "live", live_scope: "new_leads", live_since: null }, { agentLiveTest: false, createdAt: after })).toBe("shadow");
  });
});

describe("canSetScope (rule 1)", () => {
  const passed = goLiveReadiness({ good: 50, badByReason: {} });
  const failed = goLiveReadiness({ good: 10, badByReason: { made_up_fact: 1 } });

  it("test contacts never need the gate", () => {
    expect(canSetScope("test_contacts", failed)).toEqual({ ok: true });
  });

  it("pilot and all need it, with the reasons in the message", () => {
    for (const scope of ["new_leads", "all"] as const) {
      expect(canSetScope(scope, passed)).toEqual({ ok: true });
      const refused = canSetScope(scope, failed);
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.message).toContain("Rate at least 50 decisions");
      expect(!refused.ok && refused.message).toContain("made-up fact");
    }
  });
});

describe("liveChannels (rule 4)", () => {
  it("a live contact gets email only while IMAP worked in the last 30 min", () => {
    expect(liveChannels("live", new Date(NOW.getTime() - 5 * MIN), NOW)).toEqual({ email: true, emailBlockedReason: null });
    expect(liveChannels("live", new Date(NOW.getTime() - 30 * MIN), NOW).email).toBe(true);
    expect(liveChannels("live", new Date(NOW.getTime() - 31 * MIN), NOW)).toEqual({ email: false, emailBlockedReason: EMAIL_NO_REPLY_READING });
    expect(liveChannels("live", null, NOW).email).toBe(false);
  });

  it("shadow drafts are unchanged", () => {
    expect(liveChannels("shadow", null, NOW)).toEqual({ email: true, emailBlockedReason: null });
  });

  it("validateDecision treats blocked email like any unavailable channel", () => {
    const ctx: RulesContext = {
      lead: { lifecycleState: "active", agentStatus: "active", pipelineStage: "contact_attempted", email: "asha@acme.in", phoneE164: "+919876543210", agentTouchCount: 0, agentLastTouchAt: null, ownerId: null, ownerName: null },
      contactability: { email: null, whatsapp: null, phone: null },
      recentTouchTimes: [],
      lastRepActivityAt: null,
      hasSentWhatsApp: false,
      assets: [],
      allowedContacts: { emails: [], phones: [] },
      mode: "live",
      emailBlockedReason: EMAIL_NO_REPLY_READING,
    };
    const result = validateDecision({ action: "send_email", subject: "Hi", body: "Hello Asha.", assetIds: [], nextWakeInDays: 2, reasoning: "r" }, ctx, settings, NOW);
    expect(result.allowed).toBe(false);
    expect(result.finalDecision.action).toBe("wait");
    expect(result.violations[0]?.rule).toBe("channel");
  });
});

describe("sendRecheck (rule 5)", () => {
  const created = new Date(NOW.getTime() - HOUR);
  const input = (overrides: Partial<SendRecheckInput> = {}): SendRecheckInput => ({
    now: NOW,
    channel: "whatsapp",
    decisionCreatedAt: created,
    mode: "live",
    lead: { agentStatus: "active", lifecycleState: "active", email: "asha@acme.in", phoneE164: "+919876543210" },
    contactability: { email: null, whatsapp: null, phone: null },
    nurtureLongTerm: false,
    lastReplyAt: null,
    imapLastSuccessAt: new Date(NOW.getTime() - 2 * MIN),
    hasActiveWorkflowRun: false,
    settings,
    realTouchCount: 0,
    lastRealTouchAt: null,
    recentRealTouchTimes: [],
    lastRepActivityAt: null,
    ...overrides,
  });
  const cancelOf = (overrides: Partial<SendRecheckInput>) => {
    const result = sendRecheck(input(overrides));
    return "cancel" in result ? result.cancel : null;
  };

  it("passes for an eligible live contact, on both channels", () => {
    expect(sendRecheck(input())).toEqual({ ok: true });
    expect(sendRecheck(input({ channel: "email" }))).toEqual({ ok: true });
  });

  it("a reply after the decision cancels; one before it doesn't", () => {
    expect(cancelOf({ lastReplyAt: new Date(created.getTime() + MIN) })).toMatch(/replied after/);
    expect(sendRecheck(input({ lastReplyAt: new Date(created.getTime() - MIN) }))).toEqual({ ok: true });
  });

  it("an email reply after the decision cancels an email send too (lastReplyAt covers both channels)", () => {
    expect(cancelOf({ channel: "email", lastReplyAt: new Date(created.getTime() + MIN) })).toMatch(/replied after/);
  });

  it("cancels for DNC, lifecycle, AI status, opted out, bounced/unsubscribed email, a workflow run, a narrowed mode", () => {
    expect(cancelOf({ lead: { ...input().lead, lifecycleState: "do_not_contact" } })).toMatch(/Do Not Contact/);
    expect(cancelOf({ lead: { ...input().lead, lifecycleState: "lost" } })).toMatch(/lifecycle is lost/);
    expect(cancelOf({ lead: { ...input().lead, agentStatus: "paused" } })).toMatch(/paused/);
    expect(cancelOf({ lead: { ...input().lead, agentStatus: "handed_off" } })).toMatch(/handed off/);
    expect(cancelOf({ contactability: { email: null, whatsapp: "opted_out", phone: null } })).toMatch(/WhatsApp can't be used/);
    expect(cancelOf({ contactability: { email: null, whatsapp: "invalid", phone: null } })).toMatch(/WhatsApp can't be used/);
    for (const status of ["permanent_bounce", "unsubscribed", "invalid"]) {
      expect(cancelOf({ channel: "email", contactability: { email: status, whatsapp: null, phone: null } })).toMatch(/email can't be used/);
    }
    expect(cancelOf({ hasActiveWorkflowRun: true })).toMatch(/active workflow/);
    expect(cancelOf({ mode: "shadow" })).toMatch(/no longer live/);
    expect(cancelOf({ mode: "off" })).toMatch(/no longer live/);
    expect(cancelOf({ realTouchCount: 8 })).toMatch(/8 AI messages/);
  });

  it("long-term nurture is fine only when the workspace nurtures long-term", () => {
    const ltn = { lead: { ...input().lead, lifecycleState: "long_term_nurture" as const } };
    expect(cancelOf(ltn)).toMatch(/long term nurture/);
    expect(sendRecheck(input({ ...ltn, nurtureLongTerm: true }))).toEqual({ ok: true });
  });

  it("email needs healthy IMAP at send time; WhatsApp doesn't", () => {
    expect(cancelOf({ channel: "email", imapLastSuccessAt: new Date(NOW.getTime() - 31 * MIN) })).toBe(EMAIL_NO_REPLY_READING);
    expect(cancelOf({ channel: "email", imapLastSuccessAt: null })).toBe(EMAIL_NO_REPLY_READING);
    expect(sendRecheck(input({ imapLastSuccessAt: null }))).toEqual({ ok: true });
  });

  it("24 h staleness: exactly 24 h is still fine, a minute more cancels", () => {
    expect(sendRecheck(input({ decisionCreatedAt: new Date(NOW.getTime() - 24 * HOUR) }))).toEqual({ ok: true });
    expect(cancelOf({ decisionCreatedAt: new Date(NOW.getTime() - 24 * HOUR - MIN) })).toMatch(/24 hours/);
  });

  it("LL-3: a 'We tried calling' send counts toward 2 per week and 8 in total, never the 48 h gap", () => {
    // agentSendRecheck passes it in realTouchCount + recentRealTouchTimes, not in lastRealTouchAt.
    const tried = new Date(NOW.getTime() - HOUR);
    expect(sendRecheck(input({ realTouchCount: 1, recentRealTouchTimes: [tried] }))).toEqual({ ok: true });
    const aiTouch = new Date(NOW.getTime() - 72 * HOUR);
    const weekly = sendRecheck(input({ realTouchCount: 2, lastRealTouchAt: aiTouch, recentRealTouchTimes: [aiTouch, tried] }));
    expect(weekly).toEqual({ defer: expect.any(Date), reason: expect.any(String) });
    expect("defer" in weekly && weekly.defer.getTime()).toBeGreaterThanOrEqual(aiTouch.getTime() + 7 * 24 * HOUR);
    expect(cancelOf({ realTouchCount: 8, recentRealTouchTimes: [tried] })).toMatch(/8 AI messages/);
  });

  it("LL-3 rule 5: no AI send before the interested-later restart date", () => {
    expect(cancelOf({ restartAt: new Date(NOW.getTime() + 24 * HOUR) })).toMatch(/talk again later/);
    expect(sendRecheck(input({ restartAt: new Date(NOW.getTime() - HOUR) }))).toEqual({ ok: true });
  });

  it("time-based problems defer to the next allowed time (window, gap, rep quiet hours)", () => {
    const evening = ist("2026-10-28T20:00");
    const outside = sendRecheck(input({ now: evening, decisionCreatedAt: new Date(evening.getTime() - HOUR) }));
    expect(outside).toEqual({ defer: ist("2026-10-29T09:30"), reason: expect.any(String) });

    const gap = sendRecheck(input({ lastRealTouchAt: new Date(NOW.getTime() - 24 * HOUR), recentRealTouchTimes: [new Date(NOW.getTime() - 24 * HOUR)], realTouchCount: 1 }));
    expect(gap).toEqual({ defer: new Date(NOW.getTime() + 24 * HOUR), reason: expect.any(String) });

    const quiet = sendRecheck(input({ lastRepActivityAt: new Date(NOW.getTime() - 2 * HOUR) }));
    expect("defer" in quiet && quiet.defer).toEqual(new Date(NOW.getTime() + 22 * HOUR));
  });
});

describe("countQuestions (rule 7)", () => {
  it.each([
    ["No questions here.", 0],
    ["Would Tuesday work?", 1],
    ["Would Tuesday work?!", 1],
    ["Really??", 1],
    ["Is Tuesday ok? Or Wednesday?", 2],
    ["See https://acme.in/offer?ref=ai&x=1 for details.", 0],
    ["See www.acme.in/p?id=2 — does that help?", 1],
    ["क्या मंगलवार ठीक रहेगा? या बुधवार?", 2],
    ["Full-width question？", 1],
  ])("%s → %i", (text, expected) => {
    expect(countQuestions(text)).toBe(expected);
  });
});
