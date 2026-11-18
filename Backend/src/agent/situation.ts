import type { AgentContext } from "../services/agentContext.service.js";

/** Where the conversation with a contact stands, from code (never from the model). Pure. */
export interface Situation {
  /** The contact reached out to us (website / inbound form). */
  inbound: boolean;
  /** Nothing has been sent to the contact yet (no real AI send, no email/WhatsApp in the timeline; in shadow no current-playbook draft). */
  firstMessage: boolean;
  hasCallOrNote: boolean;
  /** The open deal is at a proposal stage (preparing, sent, negotiation). */
  proposalStage: boolean;
  /** E2c rule 2: a call, note, meeting or proposal exists, a real AI send got a reply, or the open deal is past qualification: no introductions. */
  conversationExists: boolean;
}

/** E2d: the inbound thanks applies only to a first message with no conversation yet (never both rules at once). */
export const situationInboundFirst = (s: Situation) => s.inbound && s.firstMessage && !s.conversationExists;

export const INBOUND_SOURCES = ["website", "inbound_form"];
const MEETING_STAGES = ["meeting_scheduled", "meeting_follow_up"];
const PROPOSAL_STAGES = ["proposal_preparation", "proposal_sent", "negotiation"];

export function situationOf(ctx: Pick<AgentContext, "lead" | "rules" | "timeline" | "pastMessages" | "internal" | "playbook" | "aiSendReplied">): Situation {
  const open = ctx.internal.deal.open;
  const proposalStage = Boolean(open && PROPOSAL_STAGES.includes(open.stage));
  const hasCallOrNote = ctx.rules.lastRepActivityAt !== null || ctx.timeline.some((t) => t.kind === "call" || t.kind === "note");
  const hasMeetingOrProposal =
    ctx.timeline.some((t) => t.kind === "meeting" || t.kind === "proposal") || Boolean(open?.latestMeeting || open?.latestProposal);
  return {
    inbound: INBOUND_SOURCES.includes(ctx.lead.source),
    // A live contact's pastMessages hold real sends only, so a draft here is always a shadow draft.
    firstMessage:
      !ctx.pastMessages.some((m) => m.outcome === "sent" || (m.playbookVersion !== null && m.playbookVersion === ctx.playbook?.version)) &&
      !ctx.timeline.some((t) => t.kind === "email" || t.kind === "whatsapp"),
    hasCallOrNote,
    proposalStage,
    conversationExists:
      hasCallOrNote || hasMeetingOrProposal || ctx.aiSendReplied || proposalStage || Boolean(open && MEETING_STAGES.includes(open.stage)),
  };
}
