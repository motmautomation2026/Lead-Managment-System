import { randomUUID } from "node:crypto";
import { automatedWindow, nextDayWindowTime, nextWindowTime, PAUSED_RETRY_MS, warmupDayFor, type SendWindow } from "./whatsappSafety.js";

/**
 * E1b email safety: the one pure "send now / defer until / block" decision for every
 * email (workflow steps, rep proposal/meeting emails, tests, and the AI agent later),
 * SMTP error classes, auto-pause and the message headers. The worker gathers the
 * inputs; nothing here reads the clock or a DB.
 */

/** LL-2: `meeting_reminder` = a meeting reminder / "Updated" confirmation to the lead (a service message like `meeting`). */
export type EmailSource = "scheduled_action" | "proposal" | "meeting" | "test" | "agent" | "reply_draft" | "meeting_reminder";

export { warmupDayFor, type SendWindow };

export interface EmailSafetyInput {
  source: EmailSource;
  now: Date;
  window: SendWindow;
  dailyCap: number;
  hourlyCap: number;
  /** Day since SMTP was first saved (1 = that IST day); null = no warm-up. */
  warmupDay: number | null;
  alreadyWarmed: boolean;
  sentToday: number;
  /** Sent since the start of the current IST clock hour. */
  sentThisHour: number;
  paused: boolean;
  /** Spacing: the earliest time the next email may go out. */
  nextSendAt: Date | null;
  /** A recipient check failed (bad address, DNC, bounced, unsubscribed): the email fails with this. */
  recipientProblem?: string | null;
  /** E3b-1 rule 4: an AI first message to a fresh inbound lead may go out in the first-inbound window (08:00–21:00 IST, any day). */
  firstInboundWindow?: boolean;
  random?: () => number;
}

export type EmailSafetyDecision = { send: true; spacingMs: number } | { defer: Date; reason: string } | { block: string };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const IST_OFFSET_MS = 330 * MINUTE_MS;
/** Longer spacing waits defer the email instead of holding the worker. */
export const MAX_INLINE_WAIT_MS = 20_000;
export const NOT_CONFIGURED_REASON = "Email is not set up. An admin must add the SMTP mailbox in Settings → Email.";
export const NOT_CONFIGURED_RETRY_MS = 15 * MINUTE_MS;
export const MAX_EMAIL_ATTEMPTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Workflow steps, the AI agent and (E3b-2a, send window only) a rep's Send of an AI reply draft; proposal, meeting and test emails are a person's choice. */
export function isAutomatedEmail(source: EmailSource): boolean {
  return source === "scheduled_action" || source === "agent" || source === "reply_draft";
}

/** Effective daily cap during warm-up of a newly configured mailbox. */
export function emailWarmupCap(day: number | null, configured: number, alreadyWarmed: boolean): number {
  if (alreadyWarmed || day === null || day > 14) return configured;
  if (day <= 3) return Math.min(configured, 20);
  if (day <= 7) return Math.min(configured, 40);
  return Math.min(configured, 70);
}

/** The start of the next IST clock hour (IST is UTC+05:30, so hours turn at :30 UTC). */
export function nextIstHour(now: Date): Date {
  const local = now.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(local / HOUR_MS) * HOUR_MS + HOUR_MS - IST_OFFSET_MS);
}

export function decideEmailSend(input: EmailSafetyInput): EmailSafetyDecision {
  const random = input.random ?? Math.random;
  const { now } = input;
  const automated = isAutomatedEmail(input.source);

  if (input.recipientProblem) return { block: input.recipientProblem };
  if (input.paused) return { defer: new Date(now.getTime() + PAUSED_RETRY_MS), reason: "Email sending is paused." };

  if (automated) {
    const inWindow = nextWindowTime(now, automatedWindow(input.source, input.window, input.firstInboundWindow), random);
    if (inWindow.getTime() > now.getTime()) return { defer: inWindow, reason: "Outside the email send window." };
  }

  const cap = emailWarmupCap(input.warmupDay, input.dailyCap, input.alreadyWarmed);
  if (input.sentToday >= cap) {
    const reason = cap < input.dailyCap ? `Warm-up daily cap (${cap}) reached.` : `Daily cap (${cap}) reached.`;
    return { defer: nextDayWindowTime(now, input.window, random), reason };
  }
  if (input.sentThisHour >= input.hourlyCap) {
    const hour = nextIstHour(now);
    return { defer: automated ? nextWindowTime(hour, input.window, random) : hour, reason: `Hourly cap (${input.hourlyCap}) reached.` };
  }

  const spacingMs = input.nextSendAt ? Math.max(0, input.nextSendAt.getTime() - now.getTime()) : 0;
  if (spacingMs > MAX_INLINE_WAIT_MS) return { defer: input.nextSendAt!, reason: "Spacing emails." };
  return { send: true, spacingMs };
}

/** Random spacing after a send, in ms. */
export function spacingAfterSend(minSeconds: number, maxSeconds: number, random = Math.random): number {
  return Math.round((minSeconds + random() * (maxSeconds - minSeconds)) * 1000);
}

// ---------------------------------------------------------------------------
// SMTP errors

export type SmtpErrorClass = "temporary" | "recipient_permanent" | "login_rejected" | "rate_limited" | "policy_blocked";

interface SmtpLikeError {
  code?: string;
  responseCode?: number;
  response?: string;
  message?: string;
}

/** The enhanced status code ("5.1.1") in an SMTP response, if any. */
function enhancedCode(text: string): string | null {
  return /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(text)?.[1] ?? null;
}

// "\brate" so "generate" / "separate" don't count.
const RATE_WORDING = /\brate|limit|too many|throttl/i;

export function classifySmtpError(err: unknown): SmtpErrorClass {
  const e = (err ?? {}) as SmtpLikeError;
  const text = `${e.response ?? ""} ${e.message ?? ""}`;
  const code = e.responseCode;
  const enhanced = enhancedCode(text);
  if (code === 535 || code === 534 || code === 530 || e.code === "EAUTH") return "login_rejected";
  // D3 8a: a 451 pauses only with a 4.7.x code or rate-limit wording; other 451s are temporary.
  if (code === 421 || enhanced?.startsWith("4.7.") || (code === 451 && RATE_WORDING.test(text))) return "rate_limited";
  if (enhanced?.startsWith("5.7.")) return "policy_blocked";
  if (code && code >= 500) return "recipient_permanent";
  return "temporary";
}

/** A 5.1.x "bad address" → the contact's email is `invalid`; other recipient rejections → `permanent_bounce`. */
export function contactabilityForRejection(err: unknown): "invalid" | "permanent_bounce" {
  const e = (err ?? {}) as SmtpLikeError;
  return enhancedCode(`${e.response ?? ""} ${e.message ?? ""}`)?.startsWith("5.1.") ? "invalid" : "permanent_bounce";
}

/** The server's reply (or the error message) for logs and the UI, one line, ≤ 300 chars. */
export function smtpReason(err: unknown): string {
  const e = (err ?? {}) as SmtpLikeError;
  return (e.response || e.message || String(err)).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Temporary failures: 5, 10, 20, 40 min. */
export function retryDelayMs(attempts: number): number {
  return Math.min(5 * 2 ** (attempts - 1), 60) * MINUTE_MS;
}

// ---------------------------------------------------------------------------
// Auto-pause

export interface EmailAutoPauseStats {
  /** Temporary send failures in the last 30 min. */
  failures30m: number;
  /** Recipient rejections (5xx) in the last 24 h (D3 adds IMAP bounces). */
  rejected24h: number;
  /** Emails sent in the last 24 h. */
  sent24h: number;
}

export const EMAIL_AUTO_PAUSE_LIMITS = { failures30m: 5, rejectRate: 0.05, rejectRateMinSends: 40 } as const;

/** The reason to auto-pause, or null. Stats count only signals after the last resume. */
export function shouldAutoPauseEmail(stats: EmailAutoPauseStats): string | null {
  const l = EMAIL_AUTO_PAUSE_LIMITS;
  if (stats.failures30m >= l.failures30m) return `${stats.failures30m} email send failures in 30 minutes.`;
  const attempts = stats.sent24h + stats.rejected24h;
  if (attempts >= l.rejectRateMinSends && stats.rejected24h / attempts >= l.rejectRate) {
    return `${stats.rejected24h} of ${attempts} emails were rejected by the recipient's server in 24 hours.`;
  }
  return null;
}

/** The pause reason for a login / rate-limit / policy response. */
export function pauseReasonFor(kind: Exclude<SmtpErrorClass, "temporary" | "recipient_permanent">, err: unknown): string {
  if (kind === "login_rejected") return "SMTP login rejected — check the password.";
  const prefix = kind === "rate_limited" ? "The mail server is limiting our sending" : "The mail server blocked our email";
  return `${prefix}: ${smtpReason(err)}`;
}

// ---------------------------------------------------------------------------
// Message

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function isValidEmailAddress(address: string): boolean {
  return address.length <= 254 && EMAIL_RE.test(address);
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** "<owner> | <company>" for emails to a contact, else the mailbox's default from name. */
export function buildFromName(defaultName: string, ownerName: string | null | undefined, companyName: string | null | undefined): string {
  const owner = ownerName?.trim();
  const company = companyName?.trim();
  if (owner && company) return `${owner} | ${company}`;
  return owner || defaultName;
}

const RE_PREFIX = /^(?:\s*re\s*:\s*)+/i;
/** E3a rule 7: the subject of a follow-up in the same thread, however many replies back. */
export const threadSubject = (subject: string) => `Re: ${subject.replace(RE_PREFIX, "")}`;
/** A follow-up whose thread is gone (the earlier email bounced) starts a new one with the plain subject. */
export const unthreadedSubject = (subject: string) => subject.replace(RE_PREFIX, "");

/** `Message-ID: <uuid@from-domain>` (D3 matches replies by In-Reply-To / References). */
export function messageIdFor(domain: string, id: string = randomUUID()): string {
  return `<${id}@${domain}>`;
}

export function listUnsubscribeHeader(address: string): string {
  return `<mailto:${address}?subject=unsubscribe>`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** The plain-text part: block tags → line breaks, links keep their URL, entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      return text && text !== href ? `${text} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#39|[a-z]+);/gi, (m, name: string) =>
      ENTITIES[name.toLowerCase()] ?? (name.startsWith("#") ? String.fromCodePoint(Number(name.slice(1))) : m),
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Connection tests (SMTP verify, IMAP login)

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ETIMEOUT", "ESOCKETTIMEDOUT", "TIMEOUT"]);

/** Plain-English text for a failed SMTP/IMAP connection test. */
export function connectionTestMessage(err: unknown, ctx: { host: string; port: number; folder?: string }): string {
  const e = (err ?? {}) as SmtpLikeError & { authenticationFailed?: boolean; serverResponseCode?: string; responseText?: string };
  const text = `${e.code ?? ""} ${e.response ?? ""} ${e.responseText ?? ""} ${e.message ?? ""}`;
  if (e.code && ["ENOTFOUND", "EAI_AGAIN", "EDNS"].includes(e.code)) return `Couldn't find the server "${ctx.host}". Check the host name.`;
  if (TIMEOUT_CODES.has(e.code ?? "") || /timed? ?out/i.test(text)) {
    return `The server didn't answer within 15 seconds. Check the host, the port (${ctx.port}) and that the network allows it.`;
  }
  if (e.code === "ECONNREFUSED" || e.code === "ECONNRESET") {
    return `The server refused the connection on port ${ctx.port}. Check the port and the security setting.`;
  }
  if (/certificate|self[- ]signed|CERT_|SSL|TLS|wrong version number|EPROTO/i.test(text)) {
    return `The secure connection failed (${e.message ?? "TLS error"}). Check that the security setting matches the port: SSL usually 465 (SMTP) / 993 (IMAP), STARTTLS usually 587.`;
  }
  if (e.authenticationFailed || e.code === "EAUTH" || e.responseCode === 535 || /AUTHENTICATIONFAILED|invalid credentials|authentication failed/i.test(text)) {
    return "The server rejected the username or password. If the mailbox uses 2-step verification (Gmail, Microsoft 365, Zoho), create an app password and use it here.";
  }
  if (ctx.folder && (e.serverResponseCode === "NONEXISTENT" || /NONEXISTENT|doesn't exist|does not exist|no such mailbox|unknown mailbox/i.test(text))) {
    return `The folder "${ctx.folder}" doesn't exist in this mailbox.`;
  }
  return `The test failed: ${smtpReason(err)}`;
}
