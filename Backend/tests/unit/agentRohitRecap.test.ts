import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { bookingLine } from "../../src/agent/composeMessage.js";
import { agreementClaim, checkMessage, messageFactsOf } from "../../src/agent/messageChecks.js";
import { buildDecisionMessages, buildGroundingMessages } from "../../src/agent/prompt.js";
import { CALL_ANGLES, leadIsDeciding, stagePlan, type StagePlanInput } from "../../src/agent/stagePlan.js";
import { sampleContext, settings as ctxSettings } from "../helpers/agentContextFixture.js";

/** E3b-2a rule 6: Rohit Saxena (meeting held, will discuss with his brother) got a day question and "As agreed". */
const ist = (local: string) => new Date(`${local}:00+05:30`);
const NOW = ist("2026-11-04T11:00");
const ROHIT_NOTES =
  "Good discussion. They supply gate and globe valves to refineries. Rohit wants to discuss with his brother (co-director) before next steps. Follow up next week.";
// The parts of Rohit's real draft that were wrong: "As agreed" (not in the notes) and the day question.
const ROHIT_DRAFT =
  "Thank you for meeting us on Monday, Rohit. As agreed, I will share a short note on how we help valve suppliers reach refinery buyers. Would Wednesday or Thursday suit you?";

const planInput = (deciding: boolean): StagePlanInput => ({
  now: NOW,
  lifecycleState: "active",
  nurtureLongTerm: false,
  pipelineStage: "meeting_scheduled",
  openDealStage: null,
  lastCallOrNoteAt: null,
  latestMeeting: { status: "completed", outcome: "follow_up_required", scheduledAt: ist("2026-11-02T11:00"), hasNotes: true, deciding },
  hasUpcomingMeeting: false,
  latestProposal: null,
  touches: [],
  conversationExists: true,
  emailUsable: true,
  whatsappUsable: true,
  firstChannel: "whatsapp",
  maxTouchesTotal: 8,
  repOwnedBefore: false,
});

describe("leadIsDeciding", () => {
  it.each([
    [ROHIT_NOTES, true],
    ["Will think it over and revert.", true],
    ["They will decide later this month.", true],
    ["Needs internal approval first.", true],
    ["Wants to talk it over with the team.", true],
    ["They want to start with the Pune region.", false],
    ["Agreed to a pilot in December.", false],
    [null, false],
  ])("%s → %s", (notes, expected) => expect(leadIsDeciding(notes)).toBe(expected));
});

describe("meeting_recap_deciding (Rohit)", () => {
  const plan = stagePlan(planInput(true))!;
  const ctx = sampleContext({ stagePlan: plan, latestMeeting: { outcome: "follow_up_required", notes: ROHIT_NOTES } });

  it("is not a call angle: no suggested days, no booking line", () => {
    expect(plan.angle).toBe("meeting_recap_deciding");
    expect(CALL_ANGLES).not.toContain("meeting_recap_deciding");
    const user = buildDecisionMessages(ctx, ctxSettings, NOW)[1]!.content;
    expect(user).toContain("This message: meeting recap (lead deciding)");
    expect(user).toContain(`Meeting notes: ${ROHIT_NOTES}`);
    expect(user).not.toContain("Suggested days");
    expect(bookingLine("email", { bookingUrl: "https://cal.example.com/r", angle: plan.angle, isFirstWhatsApp: false })).toBeNull();
  });

  it("a recap without the deciding signal keeps the call angle", () => {
    expect(stagePlan(planInput(false))!.angle).toBe("meeting_recap");
    expect(stagePlan({ ...planInput(false), latestMeeting: { ...planInput(false).latestMeeting!, deciding: undefined } })!.angle).toBe("meeting_recap");
  });

  it("the system rules tell the writer to offer help for the discussion, not a call", () => {
    const system = buildDecisionMessages(ctx, ctxSettings, NOW)[0]!.content;
    expect(system).toContain("meeting_recap_deciding: the lead is deciding or consulting someone.");
    expect(system).toContain("Happy to share anything that helps your discussion with your brother.");
  });

  it("the code check flags Rohit's \"As agreed\" (notes record no agreement) and the checker has the example", () => {
    const decision: AgentDecision = { action: "send_whatsapp", body: ROHIT_DRAFT, assetIds: [], nextWakeInDays: 3, reasoning: "r" };
    const facts = messageFactsOf(ctx);
    expect(facts.agreementNoted).toBe(false);
    expect(checkMessage(decision, ctxSettings, facts).map((v) => v.rule)).toContain("unsupported_agreement");
    const grounding = buildGroundingMessages(decision, ctx)![0]!.content;
    expect(grounding).toContain('UNSUPPORTED: "as agreed", "as discussed"');
  });

  it("\"as agreed\" is fine when the notes record the agreement", () => {
    const agreed = sampleContext({ stagePlan: plan, latestMeeting: { outcome: "follow_up_required", notes: "Agreed to send a short note on refinery buyers." } });
    const decision: AgentDecision = { action: "send_whatsapp", body: "Thanks for your time, Rohit. As agreed, here is a short note on refinery buyers.", assetIds: [], nextWakeInDays: 3, reasoning: "r" };
    expect(checkMessage(decision, ctxSettings, messageFactsOf(agreed)).map((v) => v.rule)).not.toContain("unsupported_agreement");
  });

  it.each([
    ["As discussed, we can help.", "As discussed"],
    ["as we agreed last week", "as we agreed"],
    ["As per our discussion, here it is.", "As per our discussion"],
    ["We discussed this as a team.", null],
  ])("agreementClaim(%s) → %s", (text, expected) => expect(agreementClaim(text)).toBe(expected));
});
