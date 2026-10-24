import { describe, expect, it } from "vitest";
import {
  backfillDealStage,
  canMoveDealStage,
  dealStageForMeetingOutcome,
  dealStageForProposalStatus,
  dealStageFromLeadStage,
  defaultDealName,
  pickDealToAttach,
  type BackfillInput,
} from "../../src/domain/dealRouting.js";
import { DEAL_STAGES, MEETING_OUTCOMES, PROPOSAL_STATUSES } from "../../src/domain/enums.js";
import { ValidationError } from "../../src/errors.js";

describe("dealStageForMeetingOutcome", () => {
  it("maps every outcome per design §2.2", () => {
    const expected: Record<(typeof MEETING_OUTCOMES)[number], string | null> = {
      highly_interested: "proposal_preparation",
      proposal_required: "proposal_preparation",
      needs_more_information: "meeting_follow_up",
      follow_up_required: "meeting_follow_up",
      needs_internal_discussion: "meeting_follow_up",
      second_meeting: "meeting_scheduled",
      won: "won",
      not_interested: "lost",
      no_proposal_required: null,
    };
    for (const outcome of MEETING_OUTCOMES) expect(dealStageForMeetingOutcome(outcome)).toBe(expected[outcome]);
  });
});

describe("dealStageForProposalStatus", () => {
  it("maps every status per design §2.2", () => {
    const expected: Record<(typeof PROPOSAL_STATUSES)[number], string | null> = {
      draft: null,
      uploaded: null,
      ready_to_send: null,
      sent: "proposal_sent",
      revision_requested: "proposal_preparation",
      revised: null,
      accepted: "won",
      rejected: "lost",
      withdrawn: null,
      expired: "lost",
    };
    for (const status of PROPOSAL_STATUSES) expect(dealStageForProposalStatus(status)).toBe(expected[status]);
  });
});

describe("canMoveDealStage", () => {
  const event = { manual: false };
  it("event-driven moves go forward only", () => {
    expect(canMoveDealStage("meeting_scheduled", "proposal_preparation", event)).toBe(true);
    expect(canMoveDealStage("proposal_sent", "meeting_follow_up", event)).toBe(false);
    expect(canMoveDealStage("proposal_sent", "proposal_preparation", event)).toBe(false);
    expect(canMoveDealStage("negotiation", "won", event)).toBe(true);
    expect(canMoveDealStage("qualified", "lost", event)).toBe(true);
    expect(canMoveDealStage("meeting_scheduled", "meeting_scheduled", event)).toBe(false);
  });
  it("allows exactly the two backward exceptions", () => {
    expect(canMoveDealStage("proposal_sent", "meeting_scheduled", { manual: false, event: "second_meeting" })).toBe(true);
    expect(canMoveDealStage("proposal_sent", "proposal_preparation", { manual: false, event: "revision_requested" })).toBe(true);
    expect(canMoveDealStage("proposal_sent", "proposal_preparation", { manual: false, event: "proposal_required" })).toBe(false);
    expect(canMoveDealStage("proposal_sent", "meeting_scheduled", { manual: false, event: "revision_requested" })).toBe(false);
  });
  it("closed deals reopen only manually", () => {
    for (const to of DEAL_STAGES) {
      expect(canMoveDealStage("won", to, { manual: false, event: "second_meeting" })).toBe(false);
      expect(canMoveDealStage("lost", to, event)).toBe(false);
    }
    expect(canMoveDealStage("won", "negotiation", { manual: true })).toBe(true);
    expect(canMoveDealStage("negotiation", "qualified", { manual: true })).toBe(true);
    expect(canMoveDealStage("lost", "lost", { manual: true })).toBe(false);
  });
});

describe("dealStageFromLeadStage", () => {
  it("follows design §1.4", () => {
    expect(dealStageFromLeadStage("meeting_scheduled", "active")).toBe("meeting_scheduled");
    expect(dealStageFromLeadStage("meeting_follow_up", "active")).toBe("meeting_follow_up");
    expect(dealStageFromLeadStage("proposal_preparation", "active")).toBe("proposal_preparation");
    expect(dealStageFromLeadStage("proposal_sent", "active")).toBe("proposal_sent");
    expect(dealStageFromLeadStage("proposal_decision_pending", "long_term_nurture")).toBe("proposal_sent");
    expect(dealStageFromLeadStage("negotiation", "active")).toBe("negotiation");
    expect(dealStageFromLeadStage("new", "active")).toBe("qualified");
    expect(dealStageFromLeadStage("negotiation", "won")).toBe("won");
    expect(dealStageFromLeadStage("meeting_scheduled", "lost")).toBe("lost");
  });
});

describe("pickDealToAttach", () => {
  const older = { id: "a", updatedAt: new Date("2026-01-01") };
  const newer = { id: "b", updatedAt: new Date("2026-02-01") };
  it("takes the requested open deal of the contact", () => {
    expect(pickDealToAttach([older, newer], "a")).toEqual({ action: "attach", dealId: "a" });
  });
  it("rejects a requested deal that is not an open deal of the contact", () => {
    expect(() => pickDealToAttach([older], "other")).toThrow(ValidationError);
    expect(() => pickDealToAttach([], "other")).toThrow(ValidationError);
  });
  it("else the most recently updated open deal, else create", () => {
    expect(pickDealToAttach([older, newer])).toEqual({ action: "attach", dealId: "b" });
    expect(pickDealToAttach([])).toEqual({ action: "create" });
  });
});

describe("defaultDealName", () => {
  it("uses the service interest or New opportunity", () => {
    expect(defaultDealName("Acme", "SEO")).toBe("Acme – SEO");
    expect(defaultDealName("Acme", null)).toBe("Acme – New opportunity");
    expect(defaultDealName("Acme", "  ")).toBe("Acme – New opportunity");
  });
});

describe("backfillDealStage", () => {
  const base: BackfillInput = { lifecycleState: "active", pipelineStage: "new", contactLossReason: null, latestProposal: null, latestMeeting: null };
  it("won contact → won, even after a rejected proposal", () => {
    expect(backfillDealStage({ ...base, lifecycleState: "won", latestProposal: { status: "rejected", lossReason: "price_budget" } }).stage).toBe("won");
  });
  it("rejected/expired latest proposal → lost with its reason", () => {
    expect(backfillDealStage({ ...base, lifecycleState: "long_term_nurture", latestProposal: { status: "expired", lossReason: "no_response" } })).toEqual({ stage: "lost", lossReason: "no_response" });
  });
  it("lost contact → lost with the contact's reason; discarded/DNC/merged → lost (other)", () => {
    expect(backfillDealStage({ ...base, lifecycleState: "lost", contactLossReason: "no_urgency" })).toEqual({ stage: "lost", lossReason: "no_urgency" });
    expect(backfillDealStage({ ...base, lifecycleState: "do_not_contact" })).toEqual({ stage: "lost", lossReason: "other" });
  });
  it("proposal stage wins over meeting; draft → proposal_preparation", () => {
    const meeting = { status: "scheduled" as const, outcome: null };
    expect(backfillDealStage({ ...base, latestProposal: { status: "sent", lossReason: null }, latestMeeting: meeting }).stage).toBe("proposal_sent");
    expect(backfillDealStage({ ...base, latestProposal: { status: "draft", lossReason: null } }).stage).toBe("proposal_preparation");
    expect(backfillDealStage({ ...base, latestProposal: { status: "withdrawn", lossReason: null }, latestMeeting: meeting }).stage).toBe("meeting_scheduled");
  });
  it("meeting status/outcome, else the contact stage", () => {
    expect(backfillDealStage({ ...base, latestMeeting: { status: "completed", outcome: "proposal_required" } }).stage).toBe("proposal_preparation");
    expect(backfillDealStage({ ...base, latestMeeting: { status: "completed", outcome: "not_interested" } }).stage).toBe("meeting_follow_up");
    expect(backfillDealStage({ ...base, latestMeeting: { status: "completed", outcome: null } }).stage).toBe("meeting_follow_up");
    expect(backfillDealStage({ ...base, pipelineStage: "negotiation", latestMeeting: { status: "cancelled", outcome: null } }).stage).toBe("negotiation");
  });
});
