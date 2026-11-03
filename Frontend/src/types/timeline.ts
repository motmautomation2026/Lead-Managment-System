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
  /** D2/D4a/D3: only on a matched inbound WhatsApp or email reply of the contact (contact timeline). Never the text. */
  reply?: {
    channel: ReplyChannel;
    /** WhatsApp message id, or the email reply's id. */
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
    /** E3b-2a: the worker is writing a suggested reply. */
    drafting?: boolean;
    /** E3b-2a: the suggested reply (open or sent); null for others than the owner and admins. */
    draft?: ReplyDraft | null;
  };
}

/** E3b-2a: an AI-suggested answer to a lead's reply, for the owner to send (edited or not) or discard. */
export interface ReplyDraft {
  id: string;
  channel: ReplyChannel;
  status: "open" | "sent" | "discarded" | "superseded" | "failed";
  subject: string | null;
  body: string | null;
  edited: boolean | null;
  sentBody: string | null;
  sentByName: string | null;
  queuedAt: string | null;
  sendStatus: "queued" | "sending" | "sent" | "failed" | "cancelled" | null;
  /** While queued: when it may go (the send window's next opening). */
  sendAt: string | null;
  sentAt: string | null;
  sendError: string | null;
  createdAt: string;
  canSend: boolean;
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
export type ReplyChannel = "whatsapp" | "email";

/**
 * D2: GET /contacts/:id/replies/:messageId (D3: or /email-replies/:replyId). `text` is null with a
 * `reason` when there is nothing to show. `subject` only for email.
 */
export interface InboundReply {
  messageId: string;
  receivedAt: string;
  subject?: string | null;
  text: string | null;
  truncated: boolean;
  reason?: "not_stored" | "unreadable";
}
