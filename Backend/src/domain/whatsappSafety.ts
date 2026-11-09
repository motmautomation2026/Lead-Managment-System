import { FIRST_INBOUND_WINDOW, nextAllowedSendTime } from "../agent/rules.js";

/**
 * E1 WhatsApp safety: the one pure "send now / defer until / block" decision for
 * every WhatsApp send (workflow steps, rep proposal/meeting messages, and the AI
 * agent in E2). The worker gathers the inputs; nothing here reads the clock or a DB.
 */

/**
 * `scheduled_action` and `agent` are automated; proposal and meeting messages are a rep's choice.
 * E3b-2a: `reply_draft` (a rep's Send of an AI reply draft) follows the automated rules (send window).
 */
export type SafetySource = "scheduled_action" | "proposal" | "meeting" | "agent" | "reply_draft";

export interface SendWindow {
  /** ISO weekdays, 1 = Monday. */
  days: number[];
  /** IST wall clock, "HH:MM" or "HH:MM:SS". */
  start: string;
  end: string;
}

export const DEFAULT_SEND_WINDOW: SendWindow = { days: [1, 2, 3, 4, 5, 6], start: "09:30", end: "19:00" };

/** The window an automated send must fit: the first-inbound window for an AI first message to a fresh inbound lead (E3b-1 rule 4). */
export function automatedWindow(source: string, window: SendWindow, firstInboundWindow: boolean | undefined): SendWindow {
  return source === "agent" && firstInboundWindow ? { ...FIRST_INBOUND_WINDOW, days: [...FIRST_INBOUND_WINDOW.days] } : window;
}

export interface SafetyInput {
  source: SafetySource;
  now: Date;
  window: SendWindow;
  dailyCap: number;
  /** Day since pairing (1 = the pairing day, IST); null = paired before E1 (fully warmed). */
  warmupDay: number | null;
  sentToday: number;
  maxNewChatsPerDay: number;
  newChatsToday: number;
  /** This workspace never messaged this phone and never received a message from it (link block + opt-out line). */
  isFirstMessage: boolean;
  /** E4a: this NUMBER never messaged / heard from the phone (its new-chat limit); default isFirstMessage. */
  isNewChat?: boolean;
  text: string;
  paused: boolean;
  /** Spacing: the earliest time the next send may go out. */
  nextSendAt: Date | null;
  /** E3b-1 rule 4: an AI first message to a fresh inbound lead may go out in the first-inbound window (08:00–21:00 IST, any day). */
  firstInboundWindow?: boolean;
  random?: () => number;
}

export type SafetyDecision =
  | { send: true; text: string; typingMs: number; spacingMs: number }
  | { defer: Date; reason: string }
  | { block: string };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const IST_OFFSET_MS = 330 * MINUTE_MS;
/** Longer spacing waits defer the send instead of holding the worker's send queue. */
export const MAX_INLINE_WAIT_MS = 20_000;
export const PAUSED_RETRY_MS = 5 * MINUTE_MS;
const WINDOW_JITTER_MS = 20 * MINUTE_MS;

export const FIRST_MESSAGE_LINK_REASON = "First WhatsApp message can't contain a link";
export const OPT_OUT_LINE = "Reply STOP to opt out.";

export function isAutomated(source: SafetySource): boolean {
  return source === "scheduled_action" || source === "agent" || source === "reply_draft";
}

/** Effective daily cap during warm-up of a newly paired number. */
export function warmupCap(day: number | null, configured: number): number {
  if (day === null || day > 14) return configured;
  if (day <= 3) return Math.min(configured, 20);
  if (day <= 7) return Math.min(configured, 40);
  return Math.min(configured, 80);
}

const istDayNumber = (date: Date) => Math.floor((date.getTime() + IST_OFFSET_MS) / DAY_MS);

/** 1 on the IST day of pairing, 2 the next IST day, …; null when the pairing date is unknown. */
export function warmupDayFor(pairedAt: Date | null, now: Date): number | null {
  return pairedAt ? Math.max(1, istDayNumber(now) - istDayNumber(pairedAt) + 1) : null;
}

const LINK_RE = new RegExp(
  [
    String.raw`https?:\/\/`,
    String.raw`\bwww\.`,
    String.raw`\b(?:wa\.me|bit\.ly|t\.co|tinyurl\.com|goo\.gl|rb\.gy|cutt\.ly|is\.gd)\/`,
    // Bare domains ("acme.com/offer", "acme.co.in"), but not the domain of an email address.
    String.raw`(?<![@\w-])(?:[a-z0-9-]+\.)+(?:com|in|io|net|org|co|ly|me|app|link|ai|info|biz|xyz|site|online|shop)(?![a-z0-9-])`,
  ].join("|"),
  "i",
);

export function hasLink(text: string): boolean {
  return LINK_RE.test(text);
}

/** Appends the opt-out line unless the text already mentions STOP (the AI's composeMessage adds it). */
export function ensureOptOutLine(text: string): string {
  return /\bSTOP\b/.test(text) ? text : `${text.trimEnd()}\n\n${OPT_OUT_LINE}`;
}

/** "Typing…" time: about 2–8 s, longer for longer messages, ±20 % random. */
export function typingMsFor(text: string, random = Math.random): number {
  const base = 2_000 + text.length * 40;
  return Math.round(Math.min(8_000, Math.max(2_000, base * (0.8 + random() * 0.4))));
}

/** Now when inside the window, else its next opening plus 0–20 min (so sends don't all fire at opening). */
export function nextWindowTime(now: Date, window: SendWindow, random = Math.random): Date {
  const opening = nextAllowedSendTime(
    now,
    {
      send_days: window.days,
      send_window_start: window.start,
      send_window_end: window.end,
      min_gap_hours: 0,
      max_touches_7d: Number.POSITIVE_INFINITY,
      rep_quiet_hours: 0,
    },
    null,
    [],
  );
  return opening.getTime() > now.getTime() ? new Date(opening.getTime() + Math.floor(random() * WINDOW_JITTER_MS)) : opening;
}

/** The send window's opening on the next IST day (or later), for "over today's limit". */
export function nextDayWindowTime(now: Date, window: SendWindow, random = Math.random): Date {
  const nextIstMidnight = new Date((istDayNumber(now) + 1) * DAY_MS - IST_OFFSET_MS);
  return nextWindowTime(nextIstMidnight, window, random);
}

export function decideSend(input: SafetyInput): SafetyDecision {
  const random = input.random ?? Math.random;
  const { now } = input;
  const automated = isAutomated(input.source);

  if (input.paused) return { defer: new Date(now.getTime() + PAUSED_RETRY_MS), reason: "WhatsApp sending is paused." };

  if (automated) {
    const inWindow = nextWindowTime(now, automatedWindow(input.source, input.window, input.firstInboundWindow), random);
    if (inWindow.getTime() > now.getTime()) return { defer: inWindow, reason: "Outside the WhatsApp send window." };
  }

  const cap = warmupCap(input.warmupDay, input.dailyCap);
  if (input.sentToday >= cap) {
    const reason = cap < input.dailyCap ? `Warm-up daily cap (${cap}) reached.` : `Daily cap (${cap}) reached.`;
    return { defer: nextDayWindowTime(now, input.window, random), reason };
  }
  if ((input.isNewChat ?? input.isFirstMessage) && input.newChatsToday >= input.maxNewChatsPerDay) {
    return { defer: nextDayWindowTime(now, input.window, random), reason: `New-chat limit (${input.maxNewChatsPerDay} per day) reached.` };
  }

  let text = input.text;
  if (automated && input.isFirstMessage) {
    if (hasLink(text)) return { block: FIRST_MESSAGE_LINK_REASON };
    text = ensureOptOutLine(text);
  }

  const spacingMs = input.nextSendAt ? Math.max(0, input.nextSendAt.getTime() - now.getTime()) : 0;
  if (spacingMs > MAX_INLINE_WAIT_MS) return { defer: input.nextSendAt!, reason: "Spacing WhatsApp sends." };

  return { send: true, text, typingMs: typingMsFor(text, random), spacingMs };
}

export interface AutoPauseStats {
  /** Send failures in the last 30 min, not counting "not on WhatsApp". */
  failures30m: number;
  /** Reconnect failures in the last 30 min. */
  reconnectFailures30m: number;
  /** STOP / asked-to-stop replies in the last 24 h. */
  stops24h: number;
  sends24h: number;
}

export const AUTO_PAUSE_LIMITS = { failures30m: 5, reconnectFailures30m: 5, stops24h: 3, stopRate: 0.05, stopRateMinSends: 40 } as const;

/** The reason to auto-pause, or null. Stats count only signals after the last resume. */
export function shouldAutoPause(stats: AutoPauseStats): string | null {
  const l = AUTO_PAUSE_LIMITS;
  if (stats.failures30m >= l.failures30m) return `${stats.failures30m} WhatsApp send failures in 30 minutes.`;
  if (stats.reconnectFailures30m >= l.reconnectFailures30m) return `${stats.reconnectFailures30m} failed reconnects in 30 minutes.`;
  if (stats.stops24h >= l.stops24h) return `${stats.stops24h} contacts asked us to stop in 24 hours.`;
  if (stats.sends24h >= l.stopRateMinSends && stats.stops24h / stats.sends24h >= l.stopRate) {
    return `${stats.stops24h} of ${stats.sends24h} contacts asked us to stop in 24 hours.`;
  }
  return null;
}
