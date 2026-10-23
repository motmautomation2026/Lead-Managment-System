/** The knowledge-base search text for one lead: what the agent most likely needs facts about. */
export interface KbQueryLead {
  industry: string | null;
  pipelineStage: string;
  objectionType: string | null;
  websiteMessage: string | null;
}

export interface KbQueryCall {
  outcome: string | null;
}

const words = (value: string) => value.replace(/_/g, " ");

export function buildKbQuery(lead: KbQueryLead, lastCall: KbQueryCall | null): string {
  return [
    lead.industry?.trim() && `Industry: ${lead.industry.trim()}`,
    `Stage: ${words(lead.pipelineStage)}`,
    lead.objectionType && `Objection: ${words(lead.objectionType)}`,
    lastCall?.outcome && `Last call: ${words(lastCall.outcome)}`,
    lead.websiteMessage?.trim() && `Enquiry: ${lead.websiteMessage.trim().slice(0, 300)}`,
  ]
    .filter(Boolean)
    .join("\n");
}
