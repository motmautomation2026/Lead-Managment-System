export interface TimelineEvent {
  id: string;
  leadId: string;
  at: string;
  kind: string;
  title: string;
  actor: string;
  actorId?: string;
  source: "manual" | "automation" | "system";
  detail?: string;
  relatedTaskId?: string;
  relatedMeetingId?: string;
  relatedProposalId?: string;
  relatedCallId?: string;
  relatedWorkflowRunId?: string;
  relatedDealId?: string;
  metadata?: Record<string, unknown>;
  /** D2/D4a: only on a matched inbound WhatsApp reply of the contact (contact timeline). Never the text. */
  reply?: {
    messageId: string;
    hasText: boolean;
    canRead: boolean;
    /** D4a: null = not labelled (older reply, or still classifying). */
    label: ReplyLabel | null;
    labelSource: ReplyLabelSource | null;
    /** The rep's name when labelSource is "rep". */
    labelBy: string | null;
    classifying: boolean;
    canCorrect: boolean;
  };
}

/** D4a: what a WhatsApp reply says (backend agent/replyClassification.ts REPLY_LABELS). */
export const REPLY_LABELS = [
  "asked_to_stop",
  "not_interested",
  "annoyed",
  "positive",
  "question",
  "other",
  "unclassified",
] as const;
export type ReplyLabel = (typeof REPLY_LABELS)[number];
export type ReplyLabelSource = "keyword" | "ai" | "rep";

/** D2: GET /contacts/:id/replies/:messageId. `text` is null with a `reason` when there is nothing to show. */
export interface InboundReply {
  messageId: string;
  receivedAt: string;
  text: string | null;
  truncated: boolean;
  reason?: "not_stored" | "unreadable";
}
