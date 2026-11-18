import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { sendRecheck, type SendRecheckInput } from "../../src/agent/liveMode.js";
import { checkMessage, compoundQuestion, countQuestions } from "../../src/agent/messageChecks.js";
import { buildDecisionMessages } from "../../src/agent/prompt.js";
import { isFreshInbound, validateDecision, type AgentRuleSettings, type RulesContext } from "../../src/agent/rules.js";
import { stagePlan, type StagePlanInput } from "../../src/agent/stagePlan.js";
import { decideEmailSend, type EmailSafetyInput } from "../../src/domain/emailSafety.js";
import { DEFAULT_SEND_WINDOW, decideSend, type SafetyInput } from "../../src/domain/whatsappSafety.js";
import { draftDecision, type Usage } from "../../src/services/agentRunner.service.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { sampleContext, settings as ctxSettings } from "../helpers/agentContextFixture.js";

/** IST wall clock → Date. 2026-11-08 is a Sunday. */
const ist = (local: string) => new Date(`${local}:00+05:30`);
const HOUR = 3_600_000;
const SUNDAY_8PM = ist("2026-11-08T20:00");
const MONDAY_0930 = ist("2026-11-09T09:30");
const WEDNESDAY = ist("2026-11-04T11:00");

const settings: AgentRuleSettings = {
  send_days: [1, 2, 3, 4, 5, 6],
  send_window_start: "09:30:00",
  send_window_end: "19:00:00",
  min_gap_hours: 48,
  max_touches_7d: 2,
  max_touches_total: 8,
  email_max_words: 120,
  whatsapp_max_words: 50,
  wake_min_days: 1,
  wake_max_days: 30,
  nurture_long_term: false,
  rep_quiet_hours: 24,
};

const planInput = (overrides: Partial<StagePlanInput> = {}): StagePlanInput => ({
  now: WEDNESDAY,
  lifecycleState: "active",
  nurtureLongTerm: false,
  pipelineStage: "contact_attempted",
  openDealStage: null,
  lastCallOrNoteAt: null,
  latestMeeting: null,
  hasUpcomingMeeting: false,
  latestProposal: null,
  touches: [],
  conversationExists: false,
  emailUsable: true,
  whatsappUsable: true,
  firstChannel: "whatsapp",
  maxTouchesTotal: 8,
  repOwnedBefore: false,
  ...overrides,
});

function rulesCtx(overrides: Partial<RulesContext> = {}): RulesContext {
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
    },
    contactability: { email: null, whatsapp: null, phone: null },
    recentTouchTimes: [],
    lastRepActivityAt: null,
    hasSentWhatsApp: false,
    assets: [],
    allowedContacts: { emails: ["asha@acme.in"], phones: ["+919876543210"] },
    mode: "shadow",
    ...overrides,
  };
}

const whatsapp = (body = "Hi Asha, would Thursday or Friday suit you for a short call?"): AgentDecision => ({
  action: "send_whatsapp",
  body,
  assetIds: [],
  nextWakeInDays: 3,
  reasoning: "Follow up.",
});
const email = (body = "Hi Asha,\n\nWould Thursday or Friday suit you for a short call?"): AgentDecision => ({
  action: "send_email",
  subject: "Your enquiry",
  body,
  assetIds: [],
  nextWakeInDays: 3,
  reasoning: "Follow up.",
});

describe("E3b-1 rules 1–3: validateDecision and the stage plan", () => {
  it("meeting_scheduled: a send becomes wait until after the meeting (adjustment stage_plan)", () => {
    const plan = stagePlan(planInput({ hasUpcomingMeeting: true, latestMeeting: { status: "scheduled", outcome: null, scheduledAt: ist("2026-11-07T11:00"), hasNotes: false } }));
    const result = validateDecision(whatsapp(), rulesCtx({ stagePlan: plan }), settings, WEDNESDAY);
    expect(result.finalDecision).toMatchObject({ action: "wait", nextWakeInDays: 4 });
    expect(result.adjustments.map((a) => a.rule)).toContain("stage_plan");
    expect(result.allowed).toBe(true);
  });

  it("rep_owned: a send becomes the one handoff the first time, then wait 7 days (a handoff too)", () => {
    const first = validateDecision(email(), rulesCtx({ stagePlan: stagePlan(planInput({ openDealStage: "negotiation" })) }), settings, WEDNESDAY);
    expect(first.finalDecision).toMatchObject({ action: "handoff", title: "Rep owns this stage: the deal is in negotiation" });
    const later = stagePlan(planInput({ openDealStage: "negotiation", repOwnedBefore: true }));
    expect(validateDecision(email(), rulesCtx({ stagePlan: later }), settings, WEDNESDAY).finalDecision).toMatchObject({ action: "wait", nextWakeInDays: 7 });
    const handoff: AgentDecision = { action: "handoff", title: "Check in", urgency: "normal", reasoning: "r" };
    expect(validateDecision(handoff, rulesCtx({ stagePlan: later }), settings, WEDNESDAY).finalDecision).toMatchObject({ action: "wait", nextWakeInDays: 7 });
  });

  it("channel balance: email when WhatsApp is due → switched + channel_switch violation (fixable)", () => {
    const plan = stagePlan(planInput());
    const result = validateDecision(email(), rulesCtx({ stagePlan: plan }), settings, WEDNESDAY);
    expect(result.finalDecision.action).toBe("send_whatsapp");
    expect(result.adjustments.map((a) => a.rule)).toContain("channel_balance");
    expect(result.violations.map((v) => v.rule)).toEqual(["channel_switch"]);
    expect(result.allowed).toBe(false);
    // The due channel passes.
    expect(validateDecision(whatsapp(), rulesCtx({ stagePlan: plan }), settings, WEDNESDAY).allowed).toBe(true);
  });

  it("only one channel usable: no switch", () => {
    const plan = stagePlan(planInput({ whatsappUsable: false }));
    const result = validateDecision(email(), rulesCtx({ stagePlan: plan, lead: { ...rulesCtx().lead, phoneE164: null } }), settings, WEDNESDAY);
    expect(result.allowed).toBe(true);
    expect(result.finalDecision.action).toBe("send_email");
  });
});

describe("E3b-1 rule 3: channel switched once with regeneration (fake model)", () => {
  it("an email when WhatsApp is due is regenerated once for WhatsApp", async () => {
    const base = sampleContext();
    const plan = stagePlan(planInput({ conversationExists: true, touches: [{ at: ist("2026-10-20T10:00"), channel: "email" }] }))!;
    const ctx = sampleContext({ stagePlan: plan, rules: { ...base.rules, contactability: { email: null, whatsapp: null, phone: null }, stagePlan: plan } });
    const model = createFakeDecisionModel({ decisions: [email(), whatsapp()] });
    const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const result = await draftDecision(
      ctx,
      { model, decisionModel: "m", groundingModel: "g", prices: { m: { inputPer1M: 1, outputPer1M: 1 }, g: { inputPer1M: 1, outputPer1M: 1 } }, now: WEDNESDAY },
      usage,
    );
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.problems.some((p) => p.startsWith("channel_switch:"))).toBe(true);
    expect(result.decision.action).toBe("send_whatsapp");
    const retry = model.calls.filter((c) => c.kind === "decide")[1]!.input.messages.at(-1)!.content;
    expect(retry).toContain("channel_switch: Write this message for WhatsApp instead");
  });
});

describe("E3b-1 rule 4: speed to lead", () => {
  const created = new Date(SUNDAY_8PM.getTime() - 10 * 60_000);

  it("isFreshInbound: website / inbound form, < 2 h old, no touch", () => {
    expect(isFreshInbound({ source: "website", createdAt: created, touchCount: 0 }, SUNDAY_8PM)).toBe(true);
    expect(isFreshInbound({ source: "inbound_form", createdAt: created, touchCount: 0 }, SUNDAY_8PM)).toBe(true);
    expect(isFreshInbound({ source: "referral", createdAt: created, touchCount: 0 }, SUNDAY_8PM)).toBe(false);
    expect(isFreshInbound({ source: "website", createdAt: created, touchCount: 1 }, SUNDAY_8PM)).toBe(false);
    expect(isFreshInbound({ source: "website", createdAt: new Date(SUNDAY_8PM.getTime() - 2 * HOUR), touchCount: 0 }, SUNDAY_8PM)).toBe(false);
  });

  it("rules: the first message to a fresh website lead on Sunday 20:00 IST goes now; a follow-up waits for Monday 09:30", () => {
    expect(validateDecision(whatsapp(), rulesCtx({ freshInbound: true }), settings, SUNDAY_8PM).sendAt).toEqual(SUNDAY_8PM);
    expect(validateDecision(whatsapp(), rulesCtx(), settings, SUNDAY_8PM).sendAt).toEqual(MONDAY_0930);
    // 21:00 closes the first-inbound window too.
    expect(validateDecision(whatsapp(), rulesCtx({ freshInbound: true }), settings, ist("2026-11-08T21:30")).sendAt).toEqual(ist("2026-11-09T08:00"));
  });

  it("the send-time re-check uses the same window", () => {
    const input: SendRecheckInput = {
      now: SUNDAY_8PM,
      channel: "whatsapp",
      decisionCreatedAt: new Date(SUNDAY_8PM.getTime() - 60_000),
      mode: "live",
      lead: { agentStatus: "active", lifecycleState: "active", email: "asha@acme.in", phoneE164: "+919876543210" },
      contactability: { email: null, whatsapp: null, phone: null },
      nurtureLongTerm: false,
      lastReplyAt: null,
      imapLastSuccessAt: new Date(SUNDAY_8PM.getTime() - 60_000),
      hasActiveWorkflowRun: false,
      settings,
      realTouchCount: 0,
      lastRealTouchAt: null,
      recentRealTouchTimes: [],
      lastRepActivityAt: null,
    };
    expect(sendRecheck({ ...input, freshInbound: true })).toEqual({ ok: true, freshInbound: true });
    expect(sendRecheck(input)).toMatchObject({ defer: MONDAY_0930 });
  });

  const wa = (over: Partial<SafetyInput> = {}): SafetyInput => ({
    source: "agent",
    now: SUNDAY_8PM,
    window: DEFAULT_SEND_WINDOW,
    dailyCap: 200,
    warmupDay: null,
    sentToday: 0,
    maxNewChatsPerDay: 20,
    newChatsToday: 0,
    isFirstMessage: true,
    text: "Hi Asha, thank you for your enquiry.",
    paused: false,
    nextSendAt: null,
    random: () => 0,
    ...over,
  });
  const mail = (over: Partial<EmailSafetyInput> = {}): EmailSafetyInput => ({
    source: "agent",
    now: SUNDAY_8PM,
    window: DEFAULT_SEND_WINDOW,
    dailyCap: 100,
    hourlyCap: 20,
    warmupDay: null,
    alreadyWarmed: false,
    sentToday: 0,
    sentThisHour: 0,
    paused: false,
    nextSendAt: null,
    random: () => 0,
    ...over,
  });

  it("both channel checks: first message allowed, a follow-up (no flag) deferred to Monday 09:30", () => {
    expect(decideSend(wa({ firstInboundWindow: true }))).toMatchObject({ send: true });
    expect(decideEmailSend(mail({ firstInboundWindow: true }))).toMatchObject({ send: true });
    expect(decideSend(wa({ isFirstMessage: false }))).toEqual({ defer: MONDAY_0930, reason: "Outside the WhatsApp send window." });
    expect(decideEmailSend(mail())).toEqual({ defer: MONDAY_0930, reason: "Outside the email send window." });
    // Only the AI gets the window: a workflow step with the flag still waits.
    expect(decideSend(wa({ source: "scheduled_action", firstInboundWindow: true }))).toMatchObject({ defer: MONDAY_0930 });
  });

  it("spacing, caps, the new-chat limit and pause still apply to the fresh lead", () => {
    const spaced = new Date(SUNDAY_8PM.getTime() + 60_000);
    expect(decideSend(wa({ firstInboundWindow: true, nextSendAt: spaced }))).toEqual({ defer: spaced, reason: "Spacing WhatsApp sends." });
    expect(decideEmailSend(mail({ firstInboundWindow: true, nextSendAt: spaced }))).toEqual({ defer: spaced, reason: "Spacing emails." });
    expect(decideSend(wa({ firstInboundWindow: true, sentToday: 200 }))).toMatchObject({ reason: "Daily cap (200) reached." });
    expect(decideSend(wa({ firstInboundWindow: true, newChatsToday: 20 }))).toMatchObject({ reason: "New-chat limit (20 per day) reached." });
    expect(decideEmailSend(mail({ firstInboundWindow: true, sentToday: 100 }))).toMatchObject({ reason: "Daily cap (100) reached." });
    expect(decideEmailSend(mail({ firstInboundWindow: true, sentThisHour: 20 }))).toMatchObject({ reason: "Hourly cap (20) reached." });
    expect(decideSend(wa({ firstInboundWindow: true, paused: true }))).toMatchObject({ reason: "WhatsApp sending is paused." });
    expect(decideSend(wa({ firstInboundWindow: true, warmupDay: 1, sentToday: 20 }))).toMatchObject({ reason: "Warm-up daily cap (20) reached." });
    // E1 rule 6 too: no link in a first WhatsApp.
    expect(decideSend(wa({ firstInboundWindow: true, text: "See https://acme.in" }))).toEqual({ block: "First WhatsApp message can't contain a link" });
  });
});

describe("E3b-1 rule 6: an easy two-option question is one question", () => {
  it.each(["Would Thursday or Friday suit you?", "Would Thursday or Friday suit you for a short call?", "Does Monday or Tuesday work better?"])("%s", (q) => {
    expect(countQuestions(q)).toBe(1);
    expect(compoundQuestion(q)).toBeNull();
    const problems = checkMessage(whatsapp(`Hi Asha, happy to walk you through how we start. ${q}`), ctxSettings).map((v) => v.rule);
    expect(problems).not.toContain("one_question");
    expect(problems).not.toContain("compound_question");
  });

  it("two asks are still compound", () => {
    expect(compoundQuestion("Would Thursday or Friday suit you, or would you prefer next week?")).not.toBeNull();
  });
});

describe("E3b-1 rules 2 and 6: prompt lines", () => {
  it("lead_data says what this message is for, its channel and the suggested days; the system lists the angles", () => {
    const plan = stagePlan(planInput())!;
    const messages = buildDecisionMessages(sampleContext({ stagePlan: plan }), ctxSettings, WEDNESDAY);
    const user = messages[1]!.content;
    expect(user).toContain("This message: welcome (first message)");
    expect(user).toContain("Channel for this message: WhatsApp");
    // HOTFIX-2: the first message gets the closing sentence instead of days; a follow-up call angle keeps the days.
    expect(user).toContain("Closing sentence: I will give you a call to understand your requirements.");
    expect(user).not.toContain("Suggested days");
    const checkIn = stagePlan(planInput({ touches: [{ at: ist("2026-10-28T11:00"), channel: "email" }, { at: ist("2026-10-30T11:00"), channel: "whatsapp" }, { at: ist("2026-11-01T11:00"), channel: "email" }] }))!;
    expect(checkIn.angle).toBe("check_in");
    expect(buildDecisionMessages(sampleContext({ stagePlan: checkIn }), ctxSettings, WEDNESDAY)[1]!.content).toContain("Suggested days: Thursday or Friday");
    expect(messages[0]!.content).toContain("- proposal_timing: ask, simply, when they expect to decide on the proposal.");
    // The system message is the same with or without a plan (cached prefix).
    expect(messages[0]!.content).toBe(buildDecisionMessages(sampleContext(), ctxSettings, WEDNESDAY)[0]!.content);
  });

  it("no message now: says so, no suggested days", () => {
    const plan = stagePlan(planInput({ hasUpcomingMeeting: true, latestMeeting: { status: "scheduled", outcome: null, scheduledAt: ist("2026-11-07T11:00"), hasNotes: false } }))!;
    const user = buildDecisionMessages(sampleContext({ stagePlan: plan }), ctxSettings, WEDNESDAY)[1]!.content;
    expect(user).toContain("This message: none now (a meeting is scheduled)");
    expect(user).not.toContain("Suggested days");
  });

  it("meeting recap shows the meeting outcome notes", () => {
    const plan = stagePlan(planInput({ latestMeeting: { status: "completed", outcome: "follow_up_required", scheduledAt: ist("2026-11-02T11:00"), hasNotes: true } }))!;
    const ctx = sampleContext({ stagePlan: plan, latestMeeting: { outcome: "follow_up_required", notes: "They want to start with the Pune region." } });
    const user = buildDecisionMessages(ctx, ctxSettings, WEDNESDAY)[1]!.content;
    expect(user).toContain("This message: meeting recap");
    expect(user).toContain("Meeting notes: They want to start with the Pune region.");
  });
});
