import type { Situation } from "./situation.js";

/** The knowledge-base search text for one lead: what the agent most likely needs facts about. */
export interface KbQueryLead {
  industry: string | null;
  designation: string | null;
  source: string;
  pipelineStage: string;
  objectionType: string | null;
  websiteMessage: string | null;
}

export interface KbQueryCall {
  outcome: string | null;
}

const words = (value: string) => value.replace(/_/g, " ");

/** E2b rule 5: default topics by where the conversation stands, so a thin lead's query isn't just "Stage: new". */
export function situationTopics(situation: Pick<Situation, "hasCallOrNote" | "proposalStage">): string {
  if (situation.proposalStage) return "after proposal follow-up concerns decision timing";
  if (situation.hasCallOrNote) return "follow-up after discussion next step";
  return "first message introduction approach next step discussion";
}

export function buildKbQuery(lead: KbQueryLead, lastCall: KbQueryCall | null, situation: Pick<Situation, "hasCallOrNote" | "proposalStage">): string {
  return [
    lead.industry?.trim() && `Industry: ${lead.industry.trim()}`,
    lead.designation?.trim() && `Designation: ${lead.designation.trim()}`,
    `Source: ${words(lead.source)}`,
    `Stage: ${words(lead.pipelineStage)}`,
    lead.objectionType && `Objection: ${words(lead.objectionType)}`,
    lastCall?.outcome && `Last call: ${words(lastCall.outcome)}`,
    lead.websiteMessage?.trim() && `Enquiry: ${lead.websiteMessage.trim().slice(0, 300)}`,
    `Topics: ${situationTopics(situation)}`,
  ]
    .filter(Boolean)
    .join("\n");
}
