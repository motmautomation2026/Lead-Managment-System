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
  /** D2: only on a matched inbound WhatsApp reply of the contact (contact timeline). Never the text. */
  reply?: { messageId: string; hasText: boolean; canRead: boolean };
}

/** D2: GET /contacts/:id/replies/:messageId. `text` is null with a `reason` when there is nothing to show. */
export interface InboundReply {
  messageId: string;
  receivedAt: string;
  text: string | null;
  truncated: boolean;
  reason?: "not_stored" | "unreadable";
}
