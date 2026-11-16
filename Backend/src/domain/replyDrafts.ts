import type { ReplyChannel, ReplyLabel } from "../agent/replyClassification.js";
import type { AgentMode } from "../agent/rules.js";
import { wordCount } from "../agent/messageChecks.js";
import type { SendWindow } from "./whatsappSafety.js";
import { addWorkingTime, nextWorkingSlot } from "./workingTime.js";

/**
 * E3b-2a: reply drafts for reps and the 2-hour escalation. Pure: no I/O, `now` is passed in.
 * A draft is a suggestion for the owner; the AI never sends it. A rep's Send is the third
 * allowed send kind (after workflows and the AI) and always goes through the channel queues.
 */

/** Rule 1: labels that get a draft (never asked_to_stop, not_interested, annoyed). */
export const DRAFT_LABELS: readonly ReplyLabel[] = ["positive", "question", "other", "unclassified"];

/** E3b-2a-2 rule 1: the draft waits until the contact has been quiet this long, so one draft answers a whole burst. */
export const DRAFT_DEBOUNCE_MS = 3 * 60_000;
/** E3b-2a-2 rule 1: at most this many drafts (any outcome) per contact per IST day. */
export const MAX_DRAFTS_PER_CONTACT_PER_DAY = 3;
/** The burst sent to the writer: the newest replies since our last message, at most this many. */
export const MAX_BURST_REPLIES = 10;
/** E3b-2b rule 3: `reply_drafts.model` of a draft made by `staging:seed-reply-draft`; such a draft can never be sent. */
export const SEEDED_DRAFT_MODEL = "staging-seed";
export const SEEDED_DRAFT_SEND_MESSAGE = "Seeded test draft — sending is disabled";

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
  /** The labels of every reply in the burst (since our last message), oldest first; the last is the newest. */
  labels: (ReplyLabel | null)[];
  /** Today's (IST) drafts of this contact, any outcome. */
  contactDraftsToday: number;
  mode: AgentMode;
  spentUsd: number;
  budgetUsd: number;
  /** Today's (IST) AI decisions + reply drafts. */
  decisionsToday: number;
  maxDecisionsPerDay: number;
  hasOwner: boolean;
}

/** Rules 1 + 3, checked by the worker before any model call: null = write a draft, else why not. A stop label on ANY reply in the burst means no draft. */
export function draftSkipReason(input: DraftEligibilityInput): string | null {
  const newest = input.labels.at(-1) ?? null;
  const blocking = input.labels.find((l) => l && !DRAFT_LABELS.includes(l));
  if (blocking) return `label ${blocking}`;
  if (!newest) return "label none";
  if (input.mode === "off") return "agent off";
  if (!input.hasOwner) return "no owner";
  if (input.contactDraftsToday >= MAX_DRAFTS_PER_CONTACT_PER_DAY) return "contact's daily draft limit reached";
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
  return nextWorkingSlot(now, window);
}

// --- Rule 5: working hours (LL-2: one shared definition, domain/workingTime.ts) ---------------

export { addWorkingTime };
export const ESCALATION_WORKING_MS = 2 * 3_600_000;

/** Rule 5: a reply task created at `createdAt` is escalated once 2 working hours have passed. */
export function escalationDue(createdAt: Date, now: Date, window: SendWindow): boolean {
  return now.getTime() >= addWorkingTime(createdAt, ESCALATION_WORKING_MS, window).getTime();
}
