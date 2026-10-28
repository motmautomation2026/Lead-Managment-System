import type { LifecycleState, PipelineStage } from "../domain/enums.js";
import type { AgentDecision, SendDecision } from "./decisionSchema.js";

export type AgentMode = "off" | "shadow" | "live";
export type AgentStatus = "none" | "active" | "paused" | "handed_off" | "stopped";

/** The agent_settings columns the rules read (snake_case, as pg returns them; times are "HH:MM[:SS]"). */
export interface AgentRuleSettings {
  send_days: number[];
  send_window_start: string;
  send_window_end: string;
  min_gap_hours: number;
  max_touches_7d: number;
  max_touches_total: number;
  email_max_words: number;
  whatsapp_max_words: number;
  wake_min_days: number;
  wake_max_days: number;
  nurture_long_term: boolean;
  rep_quiet_hours: number;
}

export interface AgentAssetInfo {
  id: string;
  active: boolean;
  channels: string[];
  sizeBytes: number;
}

export interface RulesContext {
  lead: {
    lifecycleState: LifecycleState;
    agentStatus: AgentStatus;
    pipelineStage: PipelineStage;
    email: string | null;
    phoneE164: string | null;
    agentTouchCount: number;
    agentLastTouchAt: Date | null;
    ownerId: string | null;
    ownerName: string | null;
  };
  /** lead_contact_channels.status per channel (null = no row). */
  contactability: { email: string | null; whatsapp: string | null; phone: string | null };
  /** Agent sends in the last 7 days. */
  recentTouchTimes: Date[];
  /** The latest call or note a rep logged on this lead (null = none). */
  lastRepActivityAt: Date | null;
  hasSentWhatsApp: boolean;
  assets: AgentAssetInfo[];
  /** Contacts the message may mention: the lead's own plus the workspace's / owner's. */
  allowedContacts: { emails: string[]; phones: string[] };
  /** The contact's effective mode (E2: in a live workspace, a contact outside the live scope runs as shadow). */
  mode: AgentMode;
  /** E2 rule 4: why AI email is unavailable for this contact (live without healthy reply reading); null/absent = available. */
  emailBlockedReason?: string | null;
}

/** What the channel checks read. */
export interface ChannelContext {
  lead: { email: string | null; phoneE164: string | null };
  contactability: RulesContext["contactability"];
  emailBlockedReason?: string | null;
}

export interface RuleNote {
  rule: string;
  message: string;
}

export interface RulesResult {
  allowed: boolean;
  executable: boolean;
  /** shadow → draft, block → blocked, live → null (decided by the executor later). */
  outcome: "draft" | "blocked" | null;
  finalDecision: AgentDecision;
  sendAt: Date | null;
  nextWakeAt: Date | null;
  violations: RuleNote[];
  adjustments: RuleNote[];
}

export const AGENT_STAGE_ALLOW_LIST: readonly PipelineStage[] = [
  "connected_qualifying",
  "interested_later",
  "future_possibility",
  "meeting_scheduling",
  "meeting_follow_up",
  "proposal_decision_pending",
];

const EMAIL_BLOCKED_STATUSES = ["permanent_bounce", "unsubscribed", "invalid"];
const WHATSAPP_BLOCKED_STATUSES = ["invalid", "opted_out", "do_not_contact"];
// WhatsApp goes to phone_e164, so a bad phone also means a bad WhatsApp.
const PHONE_BLOCKED_STATUSES = ["invalid", "wrong_number", "do_not_contact"];
const WHATSAPP_MAX_ASSET_BYTES = 10 * 1024 * 1024;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Asia/Kolkata is a fixed UTC+05:30 (no DST). */
const IST_OFFSET_MS = 330 * 60_000;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Candidate numbers; only those with 10+ digits count, so dates ("2026-11-08") don't.
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
const OPT_OUT_RE = /\bunsubscribe\b|\bopt[\s-]?out\b/i;
const SIGNATURE_RES = [
  /^\s*(best |kind |warm )?regards\b/im,
  /^\s*sincerely\b/im,
  // "Thanks,\n<Name>": a sign-off line followed by a short capitalised name line.
  /^[ \t]*([Tt]hanks|[Tt]hank you|[Cc]heers|[Bb]est|[Ww]armly),[ \t]*\r?\n[ \t]*\p{Lu}[\p{L}.' -]{0,40}$/mu,
];
const HTML_TAG_RE = /<\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>/i;

function isSend(decision: AgentDecision): decision is SendDecision {
  return decision.action === "send_email" || decision.action === "send_whatsapp";
}

export function emailUsable(ctx: ChannelContext): boolean {
  return !ctx.emailBlockedReason && Boolean(ctx.lead.email?.trim()) && !EMAIL_BLOCKED_STATUSES.includes(ctx.contactability.email ?? "");
}

export function whatsappUsable(ctx: ChannelContext): boolean {
  return (
    Boolean(ctx.lead.phoneE164) &&
    !WHATSAPP_BLOCKED_STATUSES.includes(ctx.contactability.whatsapp ?? "") &&
    !PHONE_BLOCKED_STATUSES.includes(ctx.contactability.phone ?? "")
  );
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const digits = (value: string) => value.replace(/\D/g, "");

function contentViolations(decision: SendDecision, ctx: RulesContext): RuleNote[] {
  const notes: RuleNote[] = [];
  const all = decision.action === "send_email" ? `${decision.subject}\n${decision.body}` : decision.body;

  const allowedEmails = new Set(ctx.allowedContacts.emails.map((e) => e.trim().toLowerCase()));
  const foreignEmails = (all.match(EMAIL_RE) ?? []).filter((e) => !allowedEmails.has(e.toLowerCase()));
  if (foreignEmails.length) notes.push({ rule: "content_contacts", message: `Mentions email addresses that aren't allowed: ${foreignEmails.join(", ")}.` });

  // Compare on the last 10 digits so "+91 98765 43210" matches "9876543210".
  const allowedPhones = ctx.allowedContacts.phones.map((p) => digits(p).slice(-10));
  const foreignPhones = (all.match(PHONE_RE) ?? []).filter((p) => digits(p).length >= 10 && !allowedPhones.includes(digits(p).slice(-10)));
  if (foreignPhones.length) notes.push({ rule: "content_contacts", message: `Mentions phone numbers that aren't allowed: ${foreignPhones.join(", ")}.` });

  if (OPT_OUT_RE.test(all)) notes.push({ rule: "content_opt_out", message: "Contains opt-out/unsubscribe text; the system appends it." });
  if (SIGNATURE_RES.some((re) => re.test(decision.body))) notes.push({ rule: "content_signature", message: "Contains a sign-off/signature; the system appends it." });
  if (HTML_TAG_RE.test(all)) notes.push({ rule: "content_html", message: "Contains HTML tags; messages must be plain text." });
  return notes;
}

function assetViolations(decision: SendDecision, ctx: RulesContext): RuleNote[] {
  const notes: RuleNote[] = [];
  const channel = decision.action === "send_email" ? "email" : "whatsapp";
  const max = channel === "email" ? 3 : 1;
  if (decision.assetIds.length > max) notes.push({ rule: "assets", message: `At most ${max} asset(s) per ${channel} message.` });
  for (const id of decision.assetIds) {
    const asset = ctx.assets.find((a) => a.id === id);
    if (!asset) notes.push({ rule: "assets", message: `Asset ${id} does not exist.` });
    else if (!asset.active) notes.push({ rule: "assets", message: `Asset ${id} is not active.` });
    else if (!asset.channels.includes(channel)) notes.push({ rule: "assets", message: `Asset ${id} is not allowed on ${channel}.` });
    else if (channel === "whatsapp" && asset.sizeBytes > WHATSAPP_MAX_ASSET_BYTES) notes.push({ rule: "assets", message: `Asset ${id} is over 10 MB (WhatsApp limit).` });
  }
  return notes;
}

/**
 * Rules 1-3 of validateDecision, usable before any AI call: mode off, lifecycle
 * not eligible, or agent_status not active → the block; else null.
 */
export function precheck(
  ctx: { mode: AgentMode; lead: { lifecycleState: LifecycleState; agentStatus: AgentStatus } },
  settings: Pick<AgentRuleSettings, "nurture_long_term">,
): RuleNote | null {
  if (ctx.mode === "off") return { rule: "mode_off", message: "The agent is off for this workspace." };
  const lifecycle = ctx.lead.lifecycleState;
  if (!(lifecycle === "active" || (lifecycle === "long_term_nurture" && settings.nurture_long_term))) {
    return { rule: "lifecycle", message: `The agent doesn't act on leads in lifecycle "${lifecycle}".` };
  }
  if (ctx.lead.agentStatus !== "active") return { rule: "agent_status", message: `The agent is "${ctx.lead.agentStatus}" for this lead.` };
  return null;
}

/**
 * Validates one agent decision. Rules run in THIS order:
 *  1. mode off → BLOCK
 *  2. lifecycle active (or long_term_nurture when nurture_long_term) → else BLOCK
 *  3. agent_status active → else BLOCK
 *  4. total touches ≥ max_touches_total on a send → convert to stop (no_response)
 *  5. channel usable (sends) → else convert to wait 1 day (other channel usable) or handoff (none) + violation
 *  6. word count ≤ channel limit (sends) → else violation
 *  7. assets exist / active / allow the channel / count + size limits (sends) → else violation
 *  8. content safety (sends): foreign contacts, opt-out text, signature, HTML → violations
 *  9. update_stage only on an active lead and to the allow-list → else violation
 * 10. timing (sends): sendAt = nextAllowedSendTime(...) incl. rep quiet hours; deferrals are adjustments
 * 11. nextWakeInDays clamped to [wake_min_days, wake_max_days]; next wake = (sendAt or now) + days
 * 12. mode result: allowed = no block and no violations; executable = allowed && live;
 *     outcome: shadow → draft (violations recorded), block → blocked, live → null
 * BLOCKs stop evaluation. Pure: no I/O, `now` is passed in.
 */
export function validateDecision(decision: AgentDecision, ctx: RulesContext, settings: AgentRuleSettings, now: Date): RulesResult {
  const violations: RuleNote[] = [];
  const adjustments: RuleNote[] = [];
  const block = (rule: string, message: string): RulesResult => ({
    allowed: false,
    executable: false,
    outcome: "blocked",
    finalDecision: decision,
    sendAt: null,
    nextWakeAt: null,
    violations: [{ rule, message }],
    adjustments: [],
  });

  // 1-3: blocks
  const blocked = precheck(ctx, settings);
  if (blocked) return block(blocked.rule, blocked.message);
  const lifecycle = ctx.lead.lifecycleState;

  let final: AgentDecision = decision;

  // 4: total touches
  if (isSend(final) && ctx.lead.agentTouchCount >= settings.max_touches_total) {
    adjustments.push({ rule: "max_touches_total", message: `Reached ${settings.max_touches_total} touches in total; stopping (no response).` });
    final = { action: "stop", reason: "no_response", moveToLongTermNurture: false, reasoning: final.reasoning };
  }

  // 5: channel usable
  if (isSend(final)) {
    const wantsEmail = final.action === "send_email";
    const usable = wantsEmail ? emailUsable(ctx) : whatsappUsable(ctx);
    const otherUsable = wantsEmail ? whatsappUsable(ctx) : emailUsable(ctx);
    const channel = wantsEmail ? "Email" : "WhatsApp";
    if (!usable && otherUsable) {
      violations.push({ rule: "channel", message: `${channel} is not usable for this lead; waiting 1 day instead.` });
      final = { action: "wait", nextWakeInDays: 1, reasoning: final.reasoning };
    } else if (!usable) {
      violations.push({ rule: "channel", message: "No usable channel (email or WhatsApp); handing off." });
      final = { action: "handoff", title: "No usable channel", urgency: "normal", reasoning: final.reasoning };
    }
  }

  if (isSend(final)) {
    // 6: length
    const limit = final.action === "send_email" ? settings.email_max_words : settings.whatsapp_max_words;
    const words = countWords(final.body);
    if (words > limit) violations.push({ rule: "length", message: `${words} words; the limit is ${limit}.` });
    // 7: assets
    violations.push(...assetViolations(final, ctx));
    // 8: content safety
    violations.push(...contentViolations(final, ctx));
  }

  // 9: stage changes
  if (final.action === "update_stage") {
    if (lifecycle !== "active") violations.push({ rule: "stage", message: "The stage can only change while the lead is active." });
    else if (!AGENT_STAGE_ALLOW_LIST.includes(final.newStage)) violations.push({ rule: "stage", message: `The agent may not move a lead to "${final.newStage}".` });
  }

  // 10: timing
  let sendAt: Date | null = null;
  if (isSend(final)) {
    sendAt = nextAllowedSendTime(now, settings, ctx.lead.agentLastTouchAt, ctx.recentTouchTimes, ctx.lastRepActivityAt);
    if (ctx.lastRepActivityAt && now.getTime() < ctx.lastRepActivityAt.getTime() + settings.rep_quiet_hours * HOUR_MS) {
      adjustments.push({ rule: "rep_quiet", message: `A rep was active ${settings.rep_quiet_hours}h ago or less; waiting before contacting the lead.` });
    }
    if (sendAt > now) adjustments.push({ rule: "timing", message: `Deferred until ${sendAt.toISOString()}.` });
  }

  // 11: next wake
  let nextWakeAt: Date | null = null;
  if (isSend(final) || final.action === "wait") {
    const days = Math.min(Math.max(final.nextWakeInDays, settings.wake_min_days), settings.wake_max_days);
    if (days !== final.nextWakeInDays) {
      adjustments.push({ rule: "next_wake", message: `Next wake ${final.nextWakeInDays} day(s) clamped to ${days}.` });
      final = { ...final, nextWakeInDays: days };
    }
    nextWakeAt = new Date((sendAt ?? now).getTime() + days * DAY_MS);
  }

  // 12: mode result
  const allowed = violations.length === 0;
  return {
    allowed,
    executable: allowed && ctx.mode === "live",
    outcome: ctx.mode === "shadow" ? "draft" : null,
    finalDecision: final,
    sendAt,
    nextWakeAt,
    violations,
    adjustments,
  };
}

/** "HH:MM[:SS]" → ms after midnight. */
function timeOfDayMs(value: string): number {
  const [h = 0, m = 0, s = 0] = value.split(":").map(Number);
  return ((h * 60 + m) * 60 + s) * 1000;
}

/**
 * Earliest time ≥ now that is: ≥ min_gap_hours after lastTouchAt; ≥ rep_quiet_hours
 * after lastRepActivityAt (a rep's latest call or note); has fewer than
 * max_touches_7d touches in the 7 days before it; on a send_days weekday; inside
 * [send_window_start, send_window_end) Asia/Kolkata. Weekdays only, no holidays.
 */
export function nextAllowedSendTime(
  now: Date,
  settings: Pick<AgentRuleSettings, "send_days" | "send_window_start" | "send_window_end" | "min_gap_hours" | "max_touches_7d" | "rep_quiet_hours">,
  lastTouchAt: Date | null,
  recentTouchTimes: Date[],
  lastRepActivityAt: Date | null = null,
): Date {
  let t = now.getTime();
  if (lastTouchAt) t = Math.max(t, lastTouchAt.getTime() + settings.min_gap_hours * HOUR_MS);
  if (lastRepActivityAt) t = Math.max(t, lastRepActivityAt.getTime() + settings.rep_quiet_hours * HOUR_MS);

  // A touch counts while t - touch < 7 days. Touches are in the past, so moving t later only drops some.
  const inWindow = recentTouchTimes
    .map((d) => d.getTime())
    .filter((touch) => touch <= t && t - touch < 7 * DAY_MS)
    .sort((a, b) => a - b);
  if (inWindow.length >= settings.max_touches_7d) {
    t = Math.max(t, inWindow[inWindow.length - settings.max_touches_7d]! + 7 * DAY_MS);
  }

  // Fit into the send window, in IST wall-clock time (shifted epoch, read with UTC getters).
  const start = timeOfDayMs(settings.send_window_start);
  const end = timeOfDayMs(settings.send_window_end);
  let local = t + IST_OFFSET_MS;
  for (let i = 0; i < 8; i++) {
    const midnight = local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
    const isoWeekday = ((new Date(midnight).getUTCDay() + 6) % 7) + 1;
    const tod = local - midnight;
    if (settings.send_days.includes(isoWeekday) && tod < end) return new Date(Math.max(local, midnight + start) - IST_OFFSET_MS);
    local = midnight + DAY_MS;
  }
  throw new Error("No send day configured.");
}
