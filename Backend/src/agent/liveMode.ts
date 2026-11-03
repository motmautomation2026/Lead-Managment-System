import type { LifecycleState } from "../domain/enums.js";
import type { GoLiveReadiness } from "./readiness.js";
import { emailUsable, nextAllowedSendTime, sendWindowSettings, whatsappUsable, type AgentMode, type AgentRuleSettings, type AgentStatus, type RulesContext } from "./rules.js";
import { lifecycleEligible } from "./status.js";

/**
 * E2 Live mode, pure: which contacts are live, which scopes an admin may pick, which
 * channels a live contact may use, and the send-time re-check. No I/O; `now` is passed in.
 */

export const LIVE_SCOPES = ["test_contacts", "new_leads", "all"] as const;
export type LiveScope = (typeof LIVE_SCOPES)[number];

export const STALE_DECISION_MS = 24 * 3_600_000;
/** Rule 4: AI email needs a successful IMAP poll this recent, so replies are seen. */
export const IMAP_HEALTHY_MS = 30 * 60_000;
export const EMAIL_NO_REPLY_READING = "AI email is unavailable: the workspace's reply reading (IMAP) isn't set up or hasn't worked in the last 30 minutes.";

export interface LiveSettings {
  mode: AgentMode;
  live_scope: LiveScope;
  live_since: Date | null;
}

export interface LiveLead {
  agentLiveTest: boolean;
  createdAt: Date;
}

/**
 * Rule 2: the mode one contact runs in. Off/shadow workspaces → their mode. In a live
 * workspace a marked test contact is always live; otherwise the scope decides, and a
 * contact outside it runs as shadow.
 */
export function effectiveMode(settings: LiveSettings, lead: LiveLead): AgentMode {
  if (settings.mode !== "live") return settings.mode;
  if (lead.agentLiveTest || settings.live_scope === "all") return "live";
  if (settings.live_scope === "new_leads" && settings.live_since && lead.createdAt.getTime() >= settings.live_since.getTime()) return "live";
  return "shadow";
}

/** Rule 1: test contacts need nothing; the pilot and all contacts need the go-live gate. */
export function canSetScope(scope: LiveScope, readiness: GoLiveReadiness): { ok: true } | { ok: false; message: string } {
  if (scope === "test_contacts" || readiness.ready) return { ok: true };
  return { ok: false, message: `The go-live gate isn't passed yet: ${readiness.reasons.join(" ")}` };
}

export function imapHealthy(lastSuccessAt: Date | null, now: Date): boolean {
  return Boolean(lastSuccessAt) && now.getTime() - lastSuccessAt!.getTime() <= IMAP_HEALTHY_MS;
}

/** Rule 4: a live contact may get AI email only while reply reading works; shadow drafts are unaffected. */
export function liveChannels(mode: AgentMode, imapLastSuccessAt: Date | null, now: Date): { email: boolean; emailBlockedReason: string | null } {
  const email = mode !== "live" || imapHealthy(imapLastSuccessAt, now);
  return { email, emailBlockedReason: email ? null : EMAIL_NO_REPLY_READING };
}

export interface SendRecheckInput {
  now: Date;
  channel: "email" | "whatsapp";
  decisionCreatedAt: Date;
  /** effectiveMode() with the current settings and test mark. */
  mode: AgentMode;
  lead: { agentStatus: AgentStatus; lifecycleState: LifecycleState; email: string | null; phoneE164: string | null };
  contactability: RulesContext["contactability"];
  nurtureLongTerm: boolean;
  /** The latest matched inbound reply on ANY channel (WhatsApp or email). */
  lastReplyAt: Date | null;
  imapLastSuccessAt: Date | null;
  hasActiveWorkflowRun: boolean;
  settings: AgentRuleSettings;
  /** Real sends only (rule 6), not counting this decision. */
  realTouchCount: number;
  lastRealTouchAt: Date | null;
  recentRealTouchTimes: Date[];
  lastRepActivityAt: Date | null;
  /** E3b-1 rule 4: a fresh inbound lead's first message (rules.ts isFreshInbound) uses the first-inbound window. */
  freshInbound?: boolean;
}

export type SendRecheck = { ok: true; freshInbound?: boolean } | { defer: Date; reason: string } | { cancel: string };

/**
 * Rule 5, immediately before the provider call. Anything time-based (send window,
 * gap / weekly limit, rep quiet hours) defers to the next allowed time; everything
 * else cancels with a reason (the contact's next wake-up decides again).
 */
export function sendRecheck(input: SendRecheckInput): SendRecheck {
  const { now, lead } = input;
  if (now.getTime() - input.decisionCreatedAt.getTime() > STALE_DECISION_MS) return { cancel: "The decision is more than 24 hours old." };
  if (input.mode !== "live") return { cancel: "The contact is no longer live (AI mode or live scope changed, or the test mark was removed)." };
  if (lead.agentStatus !== "active") return { cancel: `The AI is "${lead.agentStatus.replace("_", " ")}" for this contact.` };
  if (lead.lifecycleState === "do_not_contact") return { cancel: "The contact is Do Not Contact." };
  if (!lifecycleEligible(lead.lifecycleState, input.nurtureLongTerm)) return { cancel: `The contact's lifecycle is ${lead.lifecycleState.replace(/_/g, " ")}.` };

  const channelCtx = { lead, contactability: input.contactability };
  if (input.channel === "email") {
    if (!emailUsable(channelCtx)) return { cancel: "The contact's email can't be used (missing, invalid, bounced or unsubscribed)." };
  } else if (!whatsappUsable(channelCtx)) {
    return { cancel: "The contact's WhatsApp can't be used (missing number, opted out, invalid or not on WhatsApp)." };
  }
  if (input.lastReplyAt && input.lastReplyAt.getTime() > input.decisionCreatedAt.getTime()) return { cancel: "The contact replied after this message was written." };
  if (input.channel === "email" && !imapHealthy(input.imapLastSuccessAt, now)) return { cancel: EMAIL_NO_REPLY_READING };
  if (input.hasActiveWorkflowRun) return { cancel: "The contact is in an active workflow." };
  if (input.realTouchCount >= input.settings.max_touches_total) return { cancel: `The contact already got ${input.settings.max_touches_total} AI messages.` };

  const allowed = nextAllowedSendTime(now, sendWindowSettings(input.settings, input.freshInbound), input.lastRealTouchAt, input.recentRealTouchTimes, input.lastRepActivityAt);
  if (allowed.getTime() > now.getTime()) return { defer: allowed, reason: "Waiting for the AI send window, message gap or rep quiet hours." };
  return input.freshInbound ? { ok: true, freshInbound: true } : { ok: true };
}
