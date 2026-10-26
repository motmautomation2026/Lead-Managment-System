import type { ProposalStatus } from "@/types";

/**
 * Proposal statuses that need a loss reason: mirrors the backend's LOSS_REASON_PROPOSAL_STATUSES
 * (domain/proposalRouting.ts) so the dialog can ask for it; the backend still rejects a missing one (400).
 */
export const LOSS_REASON_STATUSES: readonly ProposalStatus[] = ["rejected", "expired"];
