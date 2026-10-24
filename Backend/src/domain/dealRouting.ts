/**
 * Deal routing (B2-design §1.4, §2.2, §3). Pure: the deals service applies it.
 * Deals run alongside today's contact routing (meetingRouting / proposalRouting),
 * which is unchanged; nothing here touches the contact.
 */
import { ValidationError } from "../errors.js";
import {
  DEAL_STAGES,
  type DealStage,
  type LeadLossReason,
  type LifecycleState,
  type MeetingOutcome,
  type MeetingStatus,
  type PipelineStage,
  type ProposalStatus,
} from "./enums.js";

/** The loss reason for deals closed by a contact closing or a "not interested" meeting (no better enum value exists). */
export const DEAL_CLOSED_LOSS_REASON: LeadLossReason = "other";

/** null = no deal stage change. */
export function dealStageForMeetingOutcome(outcome: MeetingOutcome): DealStage | null {
  switch (outcome) {
    case "highly_interested":
    case "proposal_required":
      return "proposal_preparation";
    case "needs_more_information":
    case "follow_up_required":
    case "needs_internal_discussion":
      return "meeting_follow_up";
    case "second_meeting":
      return "meeting_scheduled";
    case "won":
      return "won";
    case "not_interested":
      return "lost";
    case "no_proposal_required":
      return null;
  }
}

/** null = no deal stage change. */
export function dealStageForProposalStatus(status: ProposalStatus): DealStage | null {
  switch (status) {
    case "sent":
      return "proposal_sent";
    case "revision_requested":
      return "proposal_preparation";
    case "accepted":
      return "won";
    case "rejected":
    case "expired":
      return "lost";
    case "draft":
    case "uploaded":
    case "ready_to_send":
    case "revised":
    case "withdrawn":
      return null;
  }
}

export const isClosedDealStage = (stage: DealStage) => stage === "won" || stage === "lost";

/** The two events allowed to move a deal backwards (design §2.2). */
const BACKWARD_EXCEPTIONS: Partial<Record<MeetingOutcome | ProposalStatus, DealStage>> = {
  second_meeting: "meeting_scheduled",
  revision_requested: "proposal_preparation",
};

/**
 * Manual moves may go anywhere (including reopening a won/lost deal). Event-driven
 * moves never reopen a closed deal and never go backwards, except the event's own
 * exception above. Same stage = nothing to do.
 */
export function canMoveDealStage(
  from: DealStage,
  to: DealStage,
  options: { manual: boolean; event?: MeetingOutcome | ProposalStatus },
): boolean {
  if (from === to) return false;
  if (options.manual) return true;
  if (isClosedDealStage(from)) return false;
  if (isClosedDealStage(to)) return true;
  if (options.event && BACKWARD_EXCEPTIONS[options.event] === to) return true;
  return DEAL_STAGES.indexOf(to) > DEAL_STAGES.indexOf(from);
}

const LEAD_STAGE_TO_DEAL_STAGE: Partial<Record<PipelineStage, DealStage>> = {
  meeting_scheduled: "meeting_scheduled",
  meeting_follow_up: "meeting_follow_up",
  proposal_preparation: "proposal_preparation",
  proposal_sent: "proposal_sent",
  proposal_decision_pending: "proposal_sent",
  negotiation: "negotiation",
};

/** Design §1.4 "comes from today's lead stage"; earlier lead stages → qualified. */
export function dealStageFromLeadStage(pipelineStage: PipelineStage, lifecycleState: LifecycleState): DealStage {
  if (lifecycleState === "won") return "won";
  if (lifecycleState === "lost") return "lost";
  return LEAD_STAGE_TO_DEAL_STAGE[pipelineStage] ?? "qualified";
}

export type DealAttachChoice = { action: "attach"; dealId: string } | { action: "create" };

/**
 * `openDeals` = the contact's open deals. A requested deal must be one of them
 * (open and the same contact), else ValidationError. Otherwise the most recently
 * updated open deal, otherwise create.
 */
export function pickDealToAttach(openDeals: { id: string; updatedAt: Date }[], requestedDealId?: string | null): DealAttachChoice {
  if (requestedDealId) {
    if (!openDeals.some((d) => d.id === requestedDealId)) {
      throw new ValidationError("dealId must be an open deal of this contact.");
    }
    return { action: "attach", dealId: requestedDealId };
  }
  const latest = [...openDeals].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  return latest ? { action: "attach", dealId: latest.id } : { action: "create" };
}

export function defaultDealName(companyName: string, serviceInterest?: string | null): string {
  return `${companyName.trim()} – ${serviceInterest?.trim() || "New opportunity"}`;
}

const CONTACT_CLOSED_STATES: LifecycleState[] = ["discarded", "do_not_contact", "merged"];

export interface BackfillInput {
  lifecycleState: LifecycleState;
  pipelineStage: PipelineStage;
  contactLossReason: LeadLossReason | null;
  latestProposal: { status: ProposalStatus; lossReason: LeadLossReason | null } | null;
  latestMeeting: { status: MeetingStatus; outcome: MeetingOutcome | null } | null;
}

/**
 * Design §3: won if the contact is won; lost if the latest proposal is
 * rejected/expired, the contact is lost, or (so no open deal sits on a closed
 * contact, §2.2) discarded/DNC/merged; else the latest proposal's stage, else
 * the latest meeting's, else the contact's stage.
 */
export function backfillDealStage(input: BackfillInput): { stage: DealStage; lossReason: LeadLossReason | null } {
  const { lifecycleState, latestProposal, latestMeeting } = input;
  if (lifecycleState === "won") return { stage: "won", lossReason: null };
  if (latestProposal && (latestProposal.status === "rejected" || latestProposal.status === "expired")) {
    return { stage: "lost", lossReason: latestProposal.lossReason ?? DEAL_CLOSED_LOSS_REASON };
  }
  if (lifecycleState === "lost") return { stage: "lost", lossReason: input.contactLossReason ?? DEAL_CLOSED_LOSS_REASON };
  if (CONTACT_CLOSED_STATES.includes(lifecycleState)) return { stage: "lost", lossReason: DEAL_CLOSED_LOSS_REASON };

  if (latestProposal && latestProposal.status !== "withdrawn") {
    const stage = dealStageForProposalStatus(latestProposal.status) ?? "proposal_preparation";
    // accepted on a contact that is no longer won: the contact moved on; take its stage instead.
    if (stage !== "won") return { stage, lossReason: null };
  }
  if (latestMeeting) {
    if (latestMeeting.status === "completed") {
      // won/lost outcomes only close a deal together with the contact (handled above).
      const stage = latestMeeting.outcome ? dealStageForMeetingOutcome(latestMeeting.outcome) : null;
      return { stage: stage && !isClosedDealStage(stage) ? stage : "meeting_follow_up", lossReason: null };
    } else if (["tentative", "scheduled", "confirmed", "rescheduled"].includes(latestMeeting.status)) {
      return { stage: "meeting_scheduled", lossReason: null };
    }
  }
  return { stage: dealStageFromLeadStage(input.pipelineStage, lifecycleState), lossReason: null };
}
