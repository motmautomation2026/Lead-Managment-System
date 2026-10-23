import type {
  AgentAction,
  AgentEnrollSkipReason,
  AgentOutcome,
  AgentRatingReason,
} from "@/lib/backend-client";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/labels";
import type { AgentStatus } from "@/types";

/** Display labels for AI agent codes. Display only: the server decides what is allowed. */

export const ACTION_LABEL: Record<AgentAction, string> = {
  send_email: "Email",
  send_whatsapp: "WhatsApp",
  wait: "Wait",
  handoff: "Hand off to rep",
  update_stage: "Change stage",
  stop: "Stop",
};

export const OUTCOME_LABEL: Record<AgentOutcome, string> = {
  draft: "Draft — not sent",
  sent: "Sent",
  skipped: "Skipped",
  blocked: "Blocked by rules",
  executed: "Done",
  failed: "Failed",
};

export const OUTCOME_TONE: Record<
  AgentOutcome,
  "muted" | "primary" | "warning" | "danger" | "success"
> = {
  draft: "muted",
  sent: "primary",
  skipped: "muted",
  blocked: "warning",
  executed: "success",
  failed: "danger",
};

export const RATING_REASON_LABEL: Record<AgentRatingReason, string> = {
  made_up_fact: "Made-up fact",
  internal_info_leak: "Leaked internal info",
  wrong_tone: "Wrong tone",
  wrong_timing: "Wrong timing",
  wrong_action: "Wrong action",
  other: "Other",
};
export const RATING_REASONS = Object.keys(RATING_REASON_LABEL) as AgentRatingReason[];

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  none: "—",
  active: "Active",
  paused: "Paused",
  handed_off: "Handed off",
  stopped: "Stopped",
};

export const AGENT_STATUS_TONE: Record<AgentStatus, "muted" | "success" | "warning" | "info"> = {
  none: "muted",
  active: "success",
  paused: "warning",
  handed_off: "info",
  stopped: "muted",
};

const STATUS_REASON_LABEL: Record<string, string> = {
  admin_enroll: "Enrolled by an admin",
  admin_pause: "Paused by an admin",
  admin_resume: "Resumed by an admin",
  admin_stop: "Stopped by an admin",
  auto_enroll: "Enrolled automatically as a new lead",
  meeting_booked: "Paused while a meeting is booked",
  meeting_done: "Resumed after the meeting",
  lead_replied: "The lead replied, so a rep takes over",
  lifecycle_changed: "Stopped because the lead was closed or moved out of the active pipeline",
  asked_to_stop: "The lead asked us to stop",
  not_interested: "The lead isn't interested",
};
export const statusReasonLabel = (code: string | null | undefined) =>
  code ? (STATUS_REASON_LABEL[code] ?? label(code)) : null;

const WAKE_REASON_LABEL: Record<string, string> = {
  timer: "Scheduled follow-up",
  manual_wake: "Woken by an admin",
  enrolled: "Just enrolled",
  resumed: "Just resumed",
};
export const wakeReasonLabel = (code: string) => WAKE_REASON_LABEL[code] ?? label(code);

export const ENROLL_SKIP_LABEL: Record<AgentEnrollSkipReason | "failed", string> = {
  already_active: "Already active",
  not_eligible: "Not eligible",
  permanently_stopped: "Permanently stopped",
  no_contact: "No email or phone",
  not_found: "Not found",
  failed: "Failed",
};

/** Date and time in IST, labelled. */
export const istDateTime = (iso: string | null | undefined) =>
  iso ? `${fmtDateTime(iso)} IST` : "—";

export const usd = (value: number | null | undefined) =>
  value == null ? "—" : `$${value.toFixed(value < 1 && value > 0 ? 4 : 2)}`;
