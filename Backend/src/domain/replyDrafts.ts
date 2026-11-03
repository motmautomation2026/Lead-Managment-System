import type { ReplyChannel, ReplyLabel } from "../agent/replyClassification.js";
import type { AgentMode } from "../agent/rules.js";
import { wordCount } from "../agent/messageChecks.js";
import { nextWindowTime, type SendWindow } from "./whatsappSafety.js";

/**
 * E3b-2a: reply drafts for reps and the 2-hour escalation. Pure: no I/O, `now` is passed in.
 * A draft is a suggestion for the owner; the AI never sends it. A rep's Send is the third
 * allowed send kind (after workflows and the AI) and always goes through the channel queues.
 */

/** Rule 1: labels that get a draft (never asked_to_stop, not_interested, annoyed). */
export const DRAFT_LABELS: readonly ReplyLabel[] = ["positive", "question", "other", "unclassified"];

/** Channel statuses that refuse a send on that channel (the reply's channel, or the phone for WhatsApp). */
const BLOCKED_STATUS: Record<ReplyChannel, readonly string[]> = {
  whatsapp: ["opted_out", "invalid", "wrong_number", "do_not_contact"],
  email: ["invalid", "permanent_bounce", "unsubscribed"],
};
const BLOCKED_PHONE = ["invalid", "wrong_number", "do_not_contact"];

export interface ContactSendState {
  channel: ReplyChannel;
  lifecycleState: string;
  /** The reply channel's contactability status (lead_contact_channels), null = none recorded. */
  channelStatus: string | null;
  /** WhatsApp only: the phone's status. */
  phoneStatus?: string | null;
  /** The address the reply goes to (phone_e164 / email). */
  address: string | null;
}

/** Opt-out, DNC and channel status: the checks a draft and its send share. A reason, or null = allowed. */
export function contactSendProblem(state: ContactSendState): string | null {
  if (state.lifecycleState === "do_not_contact") return "The contact is Do Not Contact.";
  if (state.lifecycleState === "merged") return "The contact was merged into another contact.";
  if (!state.address) return state.channel === "email" ? "The contact has no email address." : "The contact has no WhatsApp number.";
  if (state.channelStatus === "opted_out") return "The contact opted out of WhatsApp.";
  if (state.channelStatus === "unsubscribed") return "The contact unsubscribed from email.";
  if (state.channelStatus && BLOCKED_STATUS[state.channel].includes(state.channelStatus)) {
    return `The contact's ${state.channel === "email" ? "email" : "WhatsApp"} status is ${state.channelStatus.replace(/_/g, " ")}.`;
  }
  if (state.channel === "whatsapp" && state.phoneStatus && BLOCKED_PHONE.includes(state.phoneStatus)) return `The contact's phone status is ${state.phoneStatus.replace(/_/g, " ")}.`;
  return null;
}

export interface DraftEligibilityInput extends ContactSendState {
  label: ReplyLabel | null;
  mode: AgentMode;
  spentUsd: number;
  budgetUsd: number;
  /** Today's (IST) AI decisions + reply drafts. */
  decisionsToday: number;
  maxDecisionsPerDay: number;
  hasOwner: boolean;
}

/** Rules 1 + 3, checked by the worker before any model call: null = write a draft, else why not. */
export function draftSkipReason(input: DraftEligibilityInput): string | null {
  if (!input.label || !DRAFT_LABELS.includes(input.label)) return `label ${input.label ?? "none"}`;
  if (input.mode === "off") return "agent off";
  if (!input.hasOwner) return "no owner";
  if (input.spentUsd >= input.budgetUsd) return "monthly budget reached";
  if (input.decisionsToday >= input.maxDecisionsPerDay) return "daily decision limit reached";
  return contactSendProblem(input);
}

/**
 * The rep's Send (rule 4): owner/admin and the draft's state are checked by the caller. The AI's
 * touch limits (48 h gap, 2 per week, 8 in total) do NOT apply — the lead wrote to us — so this
 * takes no touch history at all. The channel word limit still applies to the rep's text.
 */
export function replySendProblem(state: ContactSendState, body: string, limits: { whatsapp_max_words: number; email_max_words: number }): string | null {
  if (!body.trim()) return "The reply is empty.";
  const limit = state.channel === "email" ? limits.email_max_words : limits.whatsapp_max_words;
  const words = wordCount(body);
  if (words > limit) return `${state.channel === "email" ? "Email" : "WhatsApp"} replies can be at most ${limit} words; this one has ${words}.`;
  return contactSendProblem(state);
}

/** When a queued reply may go: now inside the send window, else the window's next opening (shown as "Will send at …"). */
export function replySendAt(now: Date, window: SendWindow): Date {
  return nextWindowTime(now, window, () => 0);
}

// --- Rule 5: working hours (the workspace send window, IST) ---------------------------

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 24 * 3_600_000;
export const ESCALATION_WORKING_MS = 2 * 3_600_000;

/** The window's closing time on the IST day of `at`. */
function windowEndOn(at: Date, window: SendWindow): Date {
  const [h = 0, m = 0] = window.end.split(":").map(Number);
  const istMidnight = Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return new Date(istMidnight + (h * 60 + m) * 60_000);
}

/** `from` plus `ms` of working time (only inside the send window: its days and hours, IST). */
export function addWorkingTime(from: Date, ms: number, window: SendWindow): Date {
  let at = replySendAt(from, window);
  let left = ms;
  for (let guard = 0; guard < 400; guard++) {
    const end = windowEndOn(at, window);
    const available = end.getTime() - at.getTime();
    if (left <= available) return new Date(at.getTime() + left);
    left -= Math.max(available, 0);
    at = replySendAt(new Date(end.getTime() + 1), window);
  }
  return at;
}

/** Rule 5: a reply task created at `createdAt` is escalated once 2 working hours have passed. */
export function escalationDue(createdAt: Date, now: Date, window: SendWindow): boolean {
  return now.getTime() >= addWorkingTime(createdAt, ESCALATION_WORKING_MS, window).getTime();
}
