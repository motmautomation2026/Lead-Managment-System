import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { countWords, nextAllowedSendTime, validateDecision, type AgentRuleSettings, type RulesContext } from "../../src/agent/rules.js";

/** Asia/Kolkata wall-clock time → Date. */
const ist = (local: string) => new Date(`${local}:00+05:30`);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ASSET = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

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
};

function ctx(overrides: Partial<Omit<RulesContext, "lead">> & { lead?: Partial<RulesContext["lead"]> } = {}): RulesContext {
  const { lead, ...rest } = overrides;
  return {
    lead: {
      lifecycleState: "active",
      agentStatus: "active",
      pipelineStage: "contact_attempted",
      email: "asha@acme.in",
      phoneE164: "+919876543210",
      agentTouchCount: 0,
      agentLastTouchAt: null,
      ownerId: "owner-1",
      ownerName: "Ravi",
      ...lead,
    },
    contactability: { email: null, whatsapp: null },
    recentTouchTimes: [],
    hasSentWhatsApp: false,
    assets: [{ id: ASSET, active: true, channels: ["email", "whatsapp"], sizeBytes: 1000 }],
    allowedContacts: { emails: ["asha@acme.in", "ravi@northbeam.in"], phones: ["+919876543210", "+912240001234"] },
    mode: "shadow",
    ...rest,
  };
}

const email = (overrides: Partial<Extract<AgentDecision, { action: "send_email" }>> = {}): AgentDecision => ({
  action: "send_email",
  subject: "Following up",
  body: "Hi Asha,\n\nJust checking in on our conversation.",
  assetIds: [],
  nextWakeInDays: 3,
  reasoning: "No reply yet.",
  ...overrides,
});
const whatsapp = (overrides: Partial<Extract<AgentDecision, { action: "send_whatsapp" }>> = {}): AgentDecision => ({
  action: "send_whatsapp",
  body: "Hi Asha, checking in.",
  assetIds: [],
  nextWakeInDays: 3,
  reasoning: "r",
  ...overrides,
});
const wait = (nextWakeInDays: number): AgentDecision => ({ action: "wait", nextWakeInDays, reasoning: "r" });

// Tuesday 11:00 IST: inside the window, a send day.
const NOW = ist("2026-10-27T11:00");
const rules = (result: { violations: { rule: string }[] }) => result.violations.map((v) => v.rule);

describe("nextAllowedSendTime", () => {
  const next = (now: Date, last: Date | null = null, recent: Date[] = []) => nextAllowedSendTime(now, settings, last, recent);

  it("returns now inside the window with no history", () => {
    expect(next(NOW)).toEqual(NOW);
  });

  it("allows exactly min_gap_hours after the last touch, not 1 minute less", () => {
    const last = new Date(NOW.getTime() - 48 * HOUR);
    expect(next(NOW, last)).toEqual(NOW);
    const tooRecent = new Date(NOW.getTime() - 48 * HOUR + 60_000); // 47h59m ago
    expect(next(NOW, tooRecent)).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it("Saturday 18:59 IST is allowed; 19:00 IST moves to Monday 09:30", () => {
    expect(next(ist("2026-10-24T18:59"))).toEqual(ist("2026-10-24T18:59"));
    expect(next(ist("2026-10-24T19:00"))).toEqual(ist("2026-10-26T09:30"));
  });

  it("a Sunday moves to Monday 09:30; before the window moves to 09:30 the same day", () => {
    expect(next(ist("2026-10-25T12:00"))).toEqual(ist("2026-10-26T09:30"));
    expect(next(ist("2026-10-27T08:00"))).toEqual(ist("2026-10-27T09:30"));
  });

  it("Diwali week (Sun 2026-11-08) uses plain weekday logic, no holidays", () => {
    expect(next(ist("2026-11-08T10:00"))).toEqual(ist("2026-11-09T09:30"));
    expect(next(ist("2026-11-09T10:00"))).toEqual(ist("2026-11-09T10:00"));
  });

  it("7-day limit: 2 recent touches → the oldest + 7 days, fitted into the window", () => {
    const oldest = ist("2026-10-21T20:00"); // Wed, + 7d = Wed 28th 20:00 → after window → Thu 09:30
    const newer = ist("2026-10-24T10:00");
    expect(next(NOW, newer, [newer, oldest])).toEqual(ist("2026-10-29T09:30"));
    const inside = ist("2026-10-21T10:00"); // + 7d = Wed 28th 10:00, inside the window
    expect(next(NOW, newer, [inside, newer])).toEqual(ist("2026-10-28T10:00"));
  });

  it("touches older than 7 days don't count", () => {
    const old = new Date(NOW.getTime() - 8 * DAY);
    const older = new Date(NOW.getTime() - 9 * DAY);
    expect(next(NOW, old, [old, older])).toEqual(NOW);
  });

  it("respects custom send days (e.g. only Monday)", () => {
    expect(nextAllowedSendTime(NOW, { ...settings, send_days: [1] }, null, [])).toEqual(ist("2026-11-02T09:30"));
  });
});

describe("validateDecision", () => {
  it("1. mode off blocks everything, before any other rule", () => {
    const result = validateDecision(email(), ctx({ mode: "off", lead: { lifecycleState: "won" } }), settings, NOW);
    expect(result).toMatchObject({ allowed: false, executable: false, outcome: "blocked", sendAt: null });
    expect(rules(result)).toEqual(["mode_off"]);
  });

  it.each(["won", "lost", "discarded", "do_not_contact", "merged"] as const)("2. blocks lifecycle %s", (lifecycleState) => {
    const result = validateDecision(wait(2), ctx({ lead: { lifecycleState } }), settings, NOW);
    expect(result.outcome).toBe("blocked");
    expect(rules(result)).toEqual(["lifecycle"]);
  });

  it("2. long-term nurture: blocked with the setting off, allowed with it on", () => {
    const ltn = ctx({ lead: { lifecycleState: "long_term_nurture" } });
    expect(validateDecision(wait(2), ltn, settings, NOW).outcome).toBe("blocked");
    expect(validateDecision(wait(2), ltn, { ...settings, nurture_long_term: true }, NOW)).toMatchObject({ allowed: true, outcome: "draft" });
  });

  it.each(["none", "paused", "handed_off", "stopped"] as const)("3. blocks agent_status %s", (agentStatus) => {
    const result = validateDecision(wait(2), ctx({ lead: { agentStatus } }), settings, NOW);
    expect(rules(result)).toEqual(["agent_status"]);
  });

  it("4. total touches reached → a send becomes stop (no_response) as an adjustment", () => {
    const result = validateDecision(email(), ctx({ lead: { agentTouchCount: 8 } }), settings, NOW);
    expect(result.finalDecision).toMatchObject({ action: "stop", reason: "no_response" });
    expect(result).toMatchObject({ allowed: true, sendAt: null, nextWakeAt: null });
    expect(result.adjustments.map((a) => a.rule)).toEqual(["max_touches_total"]);
    // A non-send at the limit is untouched.
    expect(validateDecision(wait(2), ctx({ lead: { agentTouchCount: 8 } }), settings, NOW).finalDecision.action).toBe("wait");
  });

  it.each(["permanent_bounce", "unsubscribed", "invalid"])("5. email %s with WhatsApp usable → wait 1 day + violation", (status) => {
    const result = validateDecision(email(), ctx({ contactability: { email: status, whatsapp: null } }), settings, NOW);
    expect(result.finalDecision).toEqual({ action: "wait", nextWakeInDays: 1, reasoning: "No reply yet." });
    expect(rules(result)).toEqual(["channel"]);
    expect(result.nextWakeAt).toEqual(new Date(NOW.getTime() + DAY));
    expect(result).toMatchObject({ allowed: false, outcome: "draft", sendAt: null });
  });

  it.each(["invalid", "opted_out", "do_not_contact"])("5. WhatsApp %s with email usable → wait", (status) => {
    const result = validateDecision(whatsapp(), ctx({ contactability: { email: "delivered", whatsapp: status } }), settings, NOW);
    expect(result.finalDecision.action).toBe("wait");
  });

  it("5. WhatsApp without phone_e164 → wait; temporary statuses stay usable", () => {
    expect(validateDecision(whatsapp(), ctx({ lead: { phoneE164: null } }), settings, NOW).finalDecision.action).toBe("wait");
    const ok = ctx({ contactability: { email: "temporary_bounce", whatsapp: "temporarily_unreachable" } });
    expect(validateDecision(email(), ok, settings, NOW).allowed).toBe(true);
    expect(validateDecision(whatsapp(), ok, settings, NOW).allowed).toBe(true);
  });

  it("5. no usable channel → handoff 'No usable channel' (normal) + violation", () => {
    const result = validateDecision(email(), ctx({ lead: { email: null, phoneE164: null } }), settings, NOW);
    expect(result.finalDecision).toMatchObject({ action: "handoff", title: "No usable channel", urgency: "normal" });
    expect(rules(result)).toEqual(["channel"]);
    expect(result.nextWakeAt).toBeNull();
  });

  it("6. word limits per channel", () => {
    expect(rules(validateDecision(whatsapp({ body: "word ".repeat(81) }), ctx(), settings, NOW))).toEqual(["length"]);
    expect(validateDecision(whatsapp({ body: "word ".repeat(80) }), ctx(), settings, NOW).allowed).toBe(true);
    expect(rules(validateDecision(email({ body: "word ".repeat(251) }), ctx(), settings, NOW))).toEqual(["length"]);
    expect(countWords("  a\n\nb   c ")).toBe(3);
  });

  it("7. assets: unknown, inactive, wrong channel, too big for WhatsApp, too many", () => {
    const other = "11111111-1111-4111-8111-111111111111";
    const assets = [
      { id: ASSET, active: false, channels: ["email"], sizeBytes: 1 },
      { id: other, active: true, channels: ["email"], sizeBytes: 11 * 1024 * 1024 },
    ];
    expect(validateDecision(email({ assetIds: [ASSET] }), ctx({ assets }), settings, NOW).violations[0]!.message).toMatch(/not active/);
    expect(validateDecision(whatsapp({ assetIds: [other] }), ctx({ assets }), settings, NOW).violations[0]!.message).toMatch(/not allowed on whatsapp/);
    const big = [{ ...assets[1]!, channels: ["whatsapp"] }];
    expect(validateDecision(whatsapp({ assetIds: [other] }), ctx({ assets: big }), settings, NOW).violations[0]!.message).toMatch(/10 MB/);
    expect(validateDecision(email({ assetIds: ["22222222-2222-4222-8222-222222222222"] }), ctx(), settings, NOW).violations[0]!.message).toMatch(/does not exist/);
    expect(rules(validateDecision(whatsapp({ assetIds: [ASSET, ASSET] }), ctx(), settings, NOW))).toContain("assets");
    expect(validateDecision(email({ assetIds: [ASSET, ASSET, ASSET] }), ctx(), settings, NOW).allowed).toBe(true);
  });

  it.each([
    ["a foreign email", "Write to sales@rival.com", "content_contacts"],
    ["a foreign phone", "Call me on +91 99999 88888", "content_contacts"],
    ["unsubscribe text", "Click to unsubscribe anytime", "content_opt_out"],
    ["opt-out text", "You can opt-out whenever", "content_opt_out"],
    ["opt out text", "Reply to opt out", "content_opt_out"],
    ["Regards,", "Hi Asha\n\nRegards,\nRavi", "content_signature"],
    ["Best regards", "Hi Asha\n\nBest regards", "content_signature"],
    ["Thanks,\\n<Name>", "Hi Asha\n\nThanks,\nRavi Kumar", "content_signature"],
    ["Sincerely", "Hi Asha\n\nSincerely yours", "content_signature"],
    ["HTML", "Hi <b>Asha</b>", "content_html"],
  ])("8. content safety flags %s", (_label, body, rule) => {
    expect(rules(validateDecision(email({ body }), ctx(), settings, NOW))).toEqual([rule]);
  });

  it("8. allowed contacts, dates, ordinary thanks and 'regarding' pass", () => {
    const body = "Hi Asha,\n\nThanks, that helps. Regarding the 2026-11-08 date, reach Ravi at ravi@northbeam.in or 022 4000 1234, or me at asha@ACME.in / 98765 43210.\n\nTalk soon?";
    expect(validateDecision(email({ body }), ctx(), settings, NOW).violations).toEqual([]);
  });

  it("8. checks the email subject too", () => {
    expect(rules(validateDecision(email({ subject: "<i>Hi</i>" }), ctx(), settings, NOW))).toEqual(["content_html"]);
  });

  it("multiple violations are all recorded", () => {
    const body = `${"word ".repeat(90)}\nunsubscribe <br> rival@x.com\n\nRegards,\nRavi`;
    const result = validateDecision(whatsapp({ body, assetIds: ["33333333-3333-4333-8333-333333333333"] }), ctx(), settings, NOW);
    expect(rules(result)).toEqual(["length", "assets", "content_contacts", "content_opt_out", "content_signature", "content_html"]);
    expect(result).toMatchObject({ allowed: false, outcome: "draft" });
  });

  it("9. update_stage: allow-list only, active lifecycle only", () => {
    const stage = (newStage: string): AgentDecision => ({ action: "update_stage", newStage, reasoning: "r" }) as AgentDecision;
    expect(validateDecision(stage("meeting_scheduling"), ctx(), settings, NOW)).toMatchObject({ allowed: true, sendAt: null, nextWakeAt: null });
    expect(rules(validateDecision(stage("proposal_sent"), ctx(), settings, NOW))).toEqual(["stage"]);
    const ltn = ctx({ lead: { lifecycleState: "long_term_nurture" } });
    expect(rules(validateDecision(stage("meeting_scheduling"), ltn, { ...settings, nurture_long_term: true }, NOW))).toEqual(["stage"]);
  });

  it("10. timing: a deferred send is an adjustment, not a violation; next wake counts from sendAt", () => {
    const sat = ist("2026-10-24T19:30");
    const result = validateDecision(email(), ctx(), settings, sat);
    expect(result.allowed).toBe(true);
    expect(result.sendAt).toEqual(ist("2026-10-26T09:30"));
    expect(result.adjustments.map((a) => a.rule)).toEqual(["timing"]);
    expect(result.nextWakeAt).toEqual(ist("2026-10-29T09:30"));
  });

  it("10. timing uses the last touch and recent touches", () => {
    const last = new Date(NOW.getTime() - 24 * HOUR);
    const result = validateDecision(email(), ctx({ lead: { agentLastTouchAt: last }, recentTouchTimes: [last] }), settings, NOW);
    expect(result.sendAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
  });

  it("11. nextWakeInDays is clamped (0 → 1, 90 → 30) as an adjustment", () => {
    const low = validateDecision(wait(0), ctx(), settings, NOW);
    expect(low.finalDecision).toMatchObject({ nextWakeInDays: 1 });
    expect(low.nextWakeAt).toEqual(new Date(NOW.getTime() + DAY));
    expect(low.adjustments.map((a) => a.rule)).toEqual(["next_wake"]);
    const high = validateDecision(email({ nextWakeInDays: 90 }), ctx(), settings, NOW);
    expect(high.finalDecision).toMatchObject({ nextWakeInDays: 30 });
    expect(high.nextWakeAt).toEqual(new Date(NOW.getTime() + 30 * DAY));
    expect(high.allowed).toBe(true);
  });

  it("12. mode result: shadow → draft, live → executable with no outcome", () => {
    expect(validateDecision(email(), ctx({ mode: "shadow" }), settings, NOW)).toMatchObject({ allowed: true, executable: false, outcome: "draft" });
    expect(validateDecision(email(), ctx({ mode: "live" }), settings, NOW)).toMatchObject({ allowed: true, executable: true, outcome: null });
    const bad = validateDecision(email({ body: "<p>x</p>" }), ctx({ mode: "live" }), settings, NOW);
    expect(bad).toMatchObject({ allowed: false, executable: false, outcome: null });
  });

  it("handoff and stop pass through unchanged", () => {
    const handoff: AgentDecision = { action: "handoff", title: "Wants pricing call", urgency: "high", reasoning: "r" };
    expect(validateDecision(handoff, ctx(), settings, NOW)).toMatchObject({ allowed: true, finalDecision: handoff, nextWakeAt: null });
    const stop: AgentDecision = { action: "stop", reason: "asked_to_stop", moveToLongTermNurture: false, reasoning: "r" };
    expect(validateDecision(stop, ctx(), settings, NOW).finalDecision).toEqual(stop);
  });
});
