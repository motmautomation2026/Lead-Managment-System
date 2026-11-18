import type { PillTone } from "@/components/crm/status-pill";
import { DEAL_STAGES, type ContactAction, type DealStage } from "@/types";

/** Display labels only (board column names from design §1.4); the backend owns every stage rule. */
export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  qualified: "Qualified",
  meeting_scheduled: "Meeting scheduled",
  meeting_follow_up: "Meeting done / follow-up",
  proposal_preparation: "Preparing proposal",
  proposal_sent: "Proposal sent",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

export const DEAL_STAGE_TONE: Record<DealStage, PillTone> = {
  qualified: "info",
  meeting_scheduled: "primary",
  meeting_follow_up: "primary",
  proposal_preparation: "primary",
  proposal_sent: "primary",
  negotiation: "warning",
  won: "success",
  lost: "danger",
};

export const isClosedStage = (stage: DealStage) => stage === "won" || stage === "lost";
export const OPEN_DEAL_STAGES = DEAL_STAGES.filter((s) => !isClosedStage(s));

export const CONTACT_ACTION_OPTIONS: Array<{ value: ContactAction; label: string; hint: string }> =
  [
    { value: "keep", label: "Keep active", hint: "Nothing changes for the contact." },
    {
      value: "long_term_nurture",
      label: "Move to long-term nurture",
      hint: "Park the contact for later.",
    },
    {
      value: "lost",
      label: "Mark contact lost",
      hint: "Uses this loss reason; the contact's other open deals are closed as lost too.",
    },
  ];
