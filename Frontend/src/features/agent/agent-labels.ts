import type {
  AgentAction,
  AgentLiveScope,
  AgentSendStatus,
  AgentEnrollSkipReason,
  AgentOutcome,
  AgentRatingReason,
} from "@/lib/backend-client";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/labels";
import type { AgentStatus, ReplyLabel } from "@/types";

/** Display labels for AI agent codes. Display only: the server decides what is allowed. */

/** Every title the reply task can have once a label re-titles it (backend replyClassification.ts). */
export const REPLY_TASK_TITLES: readonly string[] = [
  "Lead replied on WhatsApp — respond today",
  "Asked to stop on WhatsApp — review today",
  "Not interested — review today",
  "Annoyed — review today",
  "Wants to talk — respond today",
  "Asked a question — respond today",
  // D3: email replies.
  "Lead replied by email — respond today",
  "Asked to stop by email — review today",
];

/** D4a: what a reply says (D3: WhatsApp or email). */
export const REPLY_LABEL_TEXT: Record<ReplyLabel, string> = {
  asked_to_stop: "Asked to stop",
  not_interested: "Not interested",
  annoyed: "Annoyed",
  positive: "Wants to talk",
  question: "Question",
  other: "Other",
  unclassified: "Not classified",
};

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

/** E2: which AI contacts are live. */
export const LIVE_SCOPE_LABEL: Record<AgentLiveScope, string> = {
  test_contacts: "Test contacts only",
  new_leads: "New leads (pilot)",
  all: "All AI contacts",
};

/** E2: a live send's state. */
export const SEND_STATUS_LABEL: Record<AgentSendStatus, string> = {
  queued: "Queued",
  sending: "Sending",
  sent: "Sent",
  failed: "Send failed",
  cancelled: "Cancelled",
  dry_run: "Dry run",
};
export const SEND_STATUS_TONE: Record<
  AgentSendStatus,
  "muted" | "primary" | "warning" | "danger" | "success" | "info"
> = {
  queued: "info",
  sending: "info",
  sent: "success",
  failed: "danger",
  cancelled: "warning",
  dry_run: "muted",
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

/** E2b playbook style rules checked by the grounding model (not_thanking_inbound: before E2c). */
export const STYLE_RULE_LABEL: Record<string, string> = {
  asks_lead_to_describe_business: "Asks the lead to describe their business",
  not_thanking_inbound: "Doesn't thank an inbound lead",
  introduction_mid_conversation: "Introduces us mid-conversation",
  unsupported_sector_claim: "Unsupported sector claim",
};

/** Every check name (code rules, E2b/E2c message checks, style rules) in plain words. */
export const CHECK_LABEL: Record<string, string> = {
  ...STYLE_RULE_LABEL,
  banned_phrase: "Banned phrase",
  length: "Too long",
  one_question: "More than one question",
  compound_question: "Asks two things at once",
  exclamation: "Exclamation mark",
  internal_info_leak: "Internal information leak",
  content_contacts: "Contact details not allowed",
  content_html: "Contains HTML",
  content_opt_out: "Contains opt-out text",
  content_signature: "Contains a signature",
  assets: "Attachments",
  channel: "Channel not usable",
  agent_status: "AI status",
  lifecycle: "Contact lifecycle",
  max_touches_total: "Message limit reached",
  mode_off: "AI is off",
  next_wake: "Next check-in",
  rep_quiet: "Rep was recently in touch",
  stage: "Stage change not allowed",
  timing: "Timing",
};

/** Serious problems shown in red wherever they appear (also among a regenerated attempt's failures). */
export const SERIOUS_CHECKS = ["internal_info_leak"];

/** A stored problem ("<rule>: <detail>") with its rule in plain words; other text unchanged. */
export function checkProblem(problem: string): { rule: string | null; text: string } {
  const at = problem.indexOf(": ");
  const rule = at > 0 ? problem.slice(0, at) : "";
  return CHECK_LABEL[rule]
    ? { rule, text: `${CHECK_LABEL[rule]}: ${problem.slice(at + 2)}` }
    : { rule: null, text: problem };
}

/** Date and time in IST, labelled. */
export const istDateTime = (iso: string | null | undefined) =>
  iso ? `${fmtDateTime(iso)} IST` : "—";

export const usd = (value: number | null | undefined) =>
  value == null ? "—" : `$${value.toFixed(value < 1 && value > 0 ? 4 : 2)}`;

// Rule notes carry raw ISO times (e.g. "Deferred until 2026-10-29T04:00:00.000Z"); show them in IST.
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
export const withIstTimes = (text: string, format: (iso: string) => string) =>
  text.replace(ISO_RE, (iso) => format(iso));
