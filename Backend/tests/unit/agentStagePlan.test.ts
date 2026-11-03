import { describe, expect, it } from "vitest";
import { journeyAngle, preferredChannel, stagePlan, suggestedDays, type StagePlanInput } from "../../src/agent/stagePlan.js";

const ist = (local: string) => new Date(`${local}:00+05:30`);
const NOW = ist("2026-11-04T11:00"); // a Wednesday
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3_600_000);

function input(overrides: Partial<StagePlanInput> = {}): StagePlanInput {
  return {
    now: NOW,
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
  };
}
const touches = (...channels: ("email" | "whatsapp")[]) => channels.map((channel, i) => ({ at: daysAgo(30 - i * 3), channel }));

describe("journeyAngle", () => {
  it("runs welcome → insight → client experience → check-in, then alternates, final_check always last", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => journeyAngle(i, 8, false))).toEqual([
      "welcome",
      "insight",
      "client_experience",
      "check_in",
      "insight",
      "client_experience",
      "insight",
      "final_check",
      null,
    ]);
    expect([0, 1, 2, 3, 4].map((i) => journeyAngle(i, 5, false))).toEqual(["welcome", "insight", "client_experience", "check_in", "final_check"]);
    expect([0, 1, 2].map((i) => journeyAngle(i, 3, false))).toEqual(["welcome", "insight", "final_check"]);
  });
  it("never welcomes once a conversation exists", () => {
    expect(journeyAngle(0, 8, true)).toBe("insight");
  });
});

describe("stagePlan", () => {
  it("new_no_contact: the journey by touch count", () => {
    expect(stagePlan(input())).toMatchObject({ stageKey: "new_no_contact", angle: "welcome", preferredChannel: "whatsapp" });
    expect(stagePlan(input({ touches: touches("whatsapp", "email") }))).toMatchObject({ angle: "client_experience" });
    const last = stagePlan(input({ touches: touches("whatsapp", "email", "whatsapp", "email", "whatsapp", "email", "whatsapp") }));
    expect(last).toMatchObject({ angle: "final_check" });
    const done = stagePlan(input({ touches: touches("whatsapp", "email", "whatsapp", "email", "whatsapp", "email", "whatsapp", "email") }))!;
    expect(done.angle).toBeNull();
    expect(done.allowedActions).not.toContain("send_email");
    expect(done.allowedActions).not.toContain("send_whatsapp");
  });

  it("after_call: a call newer than our last message → call_followup; then the journey without welcome", () => {
    expect(stagePlan(input({ lastCallOrNoteAt: daysAgo(1) }))).toMatchObject({ stageKey: "after_call", angle: "call_followup" });
    expect(stagePlan(input({ lastCallOrNoteAt: daysAgo(40), touches: touches("whatsapp") }))).toMatchObject({ stageKey: "after_call", angle: "insight" });
    expect(stagePlan(input({ lastCallOrNoteAt: daysAgo(1), touches: touches("whatsapp") }))).toMatchObject({ angle: "call_followup" });
  });

  it("meeting_scheduled: no sends, wait until after the meeting", () => {
    const plan = stagePlan(input({ hasUpcomingMeeting: true, latestMeeting: { status: "scheduled", outcome: null, scheduledAt: ist("2026-11-07T11:00"), hasNotes: false } }))!;
    expect(plan).toMatchObject({ stageKey: "meeting_scheduled", angle: null, fallback: { action: "wait", days: 4 } });
    expect(plan.allowedActions).toEqual(["wait", "handoff", "update_stage", "stop"]);
    // Time passed but no outcome recorded yet: still waiting.
    expect(stagePlan(input({ latestMeeting: { status: "confirmed", outcome: null, scheduledAt: daysAgo(1), hasNotes: false } }))).toMatchObject({ stageKey: "meeting_scheduled", angle: null });
  });

  it("meeting_held_no_proposal: recap, then a check-in, then at most 2 touches", () => {
    const meeting = { status: "completed", outcome: "follow_up_required", scheduledAt: daysAgo(3), hasNotes: true };
    expect(stagePlan(input({ latestMeeting: meeting }))).toMatchObject({ stageKey: "meeting_held_no_proposal", angle: "meeting_recap" });
    expect(stagePlan(input({ latestMeeting: { ...meeting, hasNotes: false } }))!.reason).toContain("no meeting notes");
    const one = [{ at: daysAgo(2), channel: "email" as const }];
    expect(stagePlan(input({ latestMeeting: meeting, touches: one }))).toMatchObject({ angle: "check_in", preferredChannel: "whatsapp" });
    const two = [...one, { at: daysAgo(1), channel: "whatsapp" as const }];
    expect(stagePlan(input({ latestMeeting: meeting, touches: two }))).toMatchObject({ angle: null, fallback: { action: "wait", days: 7 } });
    // An unsent proposal draft doesn't change it.
    expect(stagePlan(input({ latestMeeting: meeting, latestProposal: { status: "draft", sentAt: null } }))).toMatchObject({ stageKey: "meeting_held_no_proposal" });
  });

  it("meeting_no_show: reschedule 24 hours after, then back to the journey", () => {
    const meeting = { status: "no_show", outcome: null, scheduledAt: ist("2026-11-04T10:00"), hasNotes: false };
    expect(stagePlan(input({ latestMeeting: meeting }))).toMatchObject({ stageKey: "meeting_no_show", angle: null, fallback: { action: "wait", days: 1 } });
    const later = { ...meeting, scheduledAt: daysAgo(2) };
    expect(stagePlan(input({ latestMeeting: later }))).toMatchObject({ angle: "reschedule" });
    expect(stagePlan(input({ latestMeeting: later, touches: [{ at: daysAgo(1), channel: "email" }] }))).toMatchObject({ stageKey: "meeting_no_show", angle: "insight" });
  });

  it("proposal_sent: questions ≥ 2 days, timing ≥ 7, client experience ≥ 14, at most 3", () => {
    const sent = (days: number) => ({ status: "sent", sentAt: daysAgo(days) });
    expect(stagePlan(input({ latestProposal: sent(1) }))).toMatchObject({ stageKey: "proposal_sent", angle: null, fallback: { action: "wait", days: 1 } });
    expect(stagePlan(input({ latestProposal: sent(2) }))).toMatchObject({ angle: "proposal_questions" });
    const after = (days: number, n: number) => Array.from({ length: n }, (_, i) => ({ at: daysAgo(days - 2 - i), channel: "email" as const }));
    expect(stagePlan(input({ latestProposal: sent(5), touches: after(5, 1) }))).toMatchObject({ angle: null, fallback: { action: "wait", days: 2 } });
    expect(stagePlan(input({ latestProposal: sent(7), touches: after(7, 1) }))).toMatchObject({ angle: "proposal_timing" });
    expect(stagePlan(input({ latestProposal: sent(14), touches: after(14, 2) }))).toMatchObject({ angle: "client_experience" });
    expect(stagePlan(input({ latestProposal: sent(20), touches: after(20, 3) }))).toMatchObject({ angle: null, fallback: { action: "wait", days: 7 } });
  });

  it("rep_owned: no sends; one handoff the first time, then wait 7 days", () => {
    for (const overrides of [{ latestProposal: { status: "revision_requested", sentAt: null } }, { openDealStage: "negotiation" }, { pipelineStage: "negotiation" as const }]) {
      const first = stagePlan(input(overrides))!;
      expect(first).toMatchObject({ stageKey: "rep_owned", angle: null, fallback: { action: "handoff" } });
      expect(first.allowedActions).toEqual(["handoff", "stop"]);
      const later = stagePlan(input({ ...overrides, repOwnedBefore: true }))!;
      expect(later).toMatchObject({ fallback: { action: "wait", days: 7 } });
      expect(later.allowedActions).toEqual(["wait", "stop"]);
    }
  });

  it("long_term: insight / check-in at most once per 30 days", () => {
    const ltn = { lifecycleState: "long_term_nurture" as const, nurtureLongTerm: true };
    expect(stagePlan(input(ltn))).toMatchObject({ stageKey: "long_term", angle: "insight" });
    expect(stagePlan(input({ ...ltn, touches: [{ at: daysAgo(40), channel: "email" }] }))).toMatchObject({ angle: "check_in" });
    expect(stagePlan(input({ ...ltn, touches: [{ at: daysAgo(10), channel: "email" }] }))).toMatchObject({ angle: null, fallback: { action: "wait", days: 20 } });
  });

  it("returns null when the agent doesn't act on the lifecycle", () => {
    expect(stagePlan(input({ lifecycleState: "won" }))).toBeNull();
    expect(stagePlan(input({ lifecycleState: "long_term_nurture" }))).toBeNull();
  });

  it("allows only the preferred channel's send", () => {
    const plan = stagePlan(input({ touches: touches("whatsapp") }))!;
    expect(plan.preferredChannel).toBe("email");
    expect(plan.allowedActions).toContain("send_email");
    expect(plan.allowedActions).not.toContain("send_whatsapp");
  });
});

describe("preferredChannel", () => {
  const base = { touches: [], emailUsable: true, whatsappUsable: true, firstChannel: "whatsapp" as const };
  it("first touch by the setting, then the other channel than the last", () => {
    expect(preferredChannel(base)).toBe("whatsapp");
    expect(preferredChannel({ ...base, firstChannel: "email" })).toBe("email");
    expect(preferredChannel({ ...base, touches: touches("whatsapp") })).toBe("email");
    expect(preferredChannel({ ...base, touches: touches("whatsapp", "email") })).toBe("whatsapp");
  });
  it("one usable channel → that one; none → null", () => {
    expect(preferredChannel({ ...base, touches: touches("email"), whatsappUsable: false })).toBe("email");
    expect(preferredChannel({ ...base, emailUsable: false })).toBe("whatsapp");
    expect(preferredChannel({ ...base, emailUsable: false, whatsappUsable: false })).toBeNull();
  });
});

describe("suggestedDays", () => {
  it("the next two working days at least a day ahead, in IST, skipping Sundays", () => {
    expect(suggestedDays(ist("2026-11-04T11:00"))).toBe("Thursday or Friday"); // Wednesday
    expect(suggestedDays(ist("2026-11-06T18:00"))).toBe("Saturday or Monday"); // Friday
    expect(suggestedDays(ist("2026-11-07T10:00"))).toBe("Monday or Tuesday"); // Saturday
    expect(suggestedDays(ist("2026-11-08T23:00"))).toBe("Monday or Tuesday"); // Sunday night IST
    // 20:00 UTC Tuesday = 01:30 Wednesday IST.
    expect(suggestedDays(new Date("2026-11-03T20:00:00Z"))).toBe("Thursday or Friday");
  });
});
