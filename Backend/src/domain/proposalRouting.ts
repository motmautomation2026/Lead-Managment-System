import { PROPOSAL_STATUSES, type LifecycleState, type PipelineStage, type ProposalStatus, type TaskType } from "./enums.js";

/**
 * Terminal proposal statuses: their routing already moved the lead's lifecycle
 * (accepted -> won, rejected/expired -> long_term_nurture) or ended the deal
 * (withdrawn). Those side effects are one-way, so a terminal proposal never moves again.
 */
export const TERMINAL_PROPOSAL_STATUSES: readonly ProposalStatus[] = ["accepted", "rejected", "withdrawn", "expired"];

/** Statuses that need a lossReason (proposals_loss_has_reason enforces it in the DB too). */
export const LOSS_REASON_PROPOSAL_STATUSES: readonly ProposalStatus[] = ["rejected", "expired"];

/** The statuses POST /proposals/:id/status accepts from `current` (the same move is a no-op, not listed). */
export function allowedNextProposalStatuses(current: ProposalStatus): ProposalStatus[] {
  if (TERMINAL_PROPOSAL_STATUSES.includes(current)) return [];
  return PROPOSAL_STATUSES.filter((s) => s !== current);
}

/** List groups (GET /proposals/list `group`), from the status meanings above. */
export const PROPOSAL_STATUS_GROUPS = {
  open: PROPOSAL_STATUSES.filter((s) => !TERMINAL_PROPOSAL_STATUSES.includes(s)),
  awaiting_decision: ["sent"],
  won: ["accepted"],
  lost: ["rejected", "expired", "withdrawn"],
} as const satisfies Record<string, readonly ProposalStatus[]>;
export type ProposalStatusGroup = keyof typeof PROPOSAL_STATUS_GROUPS;

export interface ProposalRoutingResult {
  stage?: PipelineStage;
  lifecycle?: LifecycleState;
  task?: { type: TaskType; title: string; dueInDays: number };
  /** Cancel this lead's other open proposal-follow-up tasks (decision made). */
  cancelOpenProposalFollowUps?: boolean;
  /** Cancel every open task for the lead (Won — no acquisition next-action needed). */
  cancelAllOpenTasks?: boolean;
  workflowTrigger?: "proposal_pending";
}

/**
 * Proposal status routing (product brief, "PROPOSALS" section).
 *
 * `rejected`/`expired` are documented as moving "toward Lost or Long-Term
 * Nurture" with the explicit instruction not to invent aggressive behavior
 * and to use a safe default — Long-Term Nurture (non-destructive, matches
 * the existing frontend mock's Rejected handling) is that default. A
 * salesperson who confirms the lead is truly dead can still mark it Lost
 * explicitly via the lead-level endpoint.
 *
 * `draft`/`uploaded`/`ready_to_send`/`revised`/`withdrawn` have no
 * automatic pipeline/lifecycle effect — nothing in the product brief
 * specifies one, so we only record the status change (see proposals
 * service) rather than guessing.
 */
export function routeProposalStatus(status: ProposalStatus): ProposalRoutingResult {
  switch (status) {
    case "sent":
      return {
        stage: "proposal_decision_pending",
        task: { type: "proposal_follow_up", title: "Follow up on proposal", dueInDays: 3 },
        workflowTrigger: "proposal_pending",
      };
    case "revision_requested":
      return {
        stage: "proposal_preparation",
        task: { type: "prepare_proposal", title: "Revise proposal per customer feedback", dueInDays: 2 },
        cancelOpenProposalFollowUps: true,
      };
    case "accepted":
      return {
        lifecycle: "won",
        cancelAllOpenTasks: true,
      };
    case "rejected":
      // Lost / Deferred Proposal Reactivation: the loss reason (captured by
      // the caller onto proposals.loss_reason — see proposals.service.ts)
      // decides the reactivation approach/content; routing here only
      // decides the generic default timing.
      return {
        lifecycle: "long_term_nurture",
        task: { type: "re_engage", title: "Re-engage after rejection", dueInDays: 45 },
        cancelOpenProposalFollowUps: true,
      };
    case "expired":
      return {
        lifecycle: "long_term_nurture",
        task: { type: "re_engage", title: "Re-engage after proposal expired", dueInDays: 45 },
        cancelOpenProposalFollowUps: true,
      };
    case "draft":
    case "uploaded":
    case "ready_to_send":
    case "revised":
    case "withdrawn":
      return {};
  }
}
