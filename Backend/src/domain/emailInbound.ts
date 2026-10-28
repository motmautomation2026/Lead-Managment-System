import { simpleParser, type AddressObject, type MailParserOptions, type ParsedMail } from "mailparser";
import { htmlToText } from "./emailSafety.js";

/**
 * D3: what a message read from the workspace mailbox is (rule 3), the bounce it reports,
 * the reply text without the quoted history, and the ids that link it to our emails.
 * Pure: no clock, no DB. Never log what these return.
 */

export type InboundEmailKind = "reply" | "bounce" | "bounce_temporary" | "auto_reply" | "unsubscribe" | "ignored";

export const MAX_REPLY_CHARS = 4000;
/** Larger messages are read only this far: the text and DSN parts come first. */
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

// No linkify / html-to-text on attacker-controlled mail (both have DoS advisories): HTML is converted
// with our own htmlToText only when there is no text part. keepDeliveryStatus (missing from
// @types/mailparser) keeps a DSN's message/delivery-status part as an attachment for parseDsn.
const PARSE_OPTIONS = { skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true, skipImageLinks: true, keepDeliveryStatus: true } as MailParserOptions;

export function parseInboundEmail(source: Buffer | string): Promise<ParsedMail> {
  return simpleParser(source, PARSE_OPTIONS);
}

/** The raw header value (unfolded), "" when absent. Raw lines: mailparser restructures some (List-*). */
const header = (parsed: ParsedMail, name: string): string => {
  const line = parsed.headerLines.find((h) => h.key === name)?.line ?? "";
  return line.slice(line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim();
};

const addressesOf = (field: AddressObject | AddressObject[] | undefined): string[] =>
  (Array.isArray(field) ? field : field ? [field] : []).flatMap((a) => a.value.map((v) => v.address?.trim().toLowerCase() ?? "")).filter(Boolean);

export const fromAddressOf = (parsed: ParsedMail): string | null => addressesOf(parsed.from)[0] ?? null;

// ---------------------------------------------------------------------------
// Bounces (rule 3a)

export interface Dsn {
  /** Enhanced status code, e.g. "5.1.1"; "5.0.0" when an X-Failed-Recipients bounce gives none. */
  status: string;
  permanent: boolean;
  recipient: string | null;
  /** The bounced email's Message-ID (`<…>`), if the DSN carries it. */
  originalMessageId: string | null;
  /** Diagnostic-Code, one line, ≤ 300 chars. */
  diagnostic: string | null;
}

const ENHANCED = /\b([245]\.\d{1,3}\.\d{1,3})\b/;
const MESSAGE_ID_LINE = /^message-id:\s*(<[^>\s]+>)/im;
const BOUNCE_SENDER = /^(mailer-daemon|postmaster)@/i;
const BOUNCE_SUBJECT = /^\s*(undeliverable|undelivered mail|mail delivery failed|returned mail|delivery status notification \((failure|delay)\))/i;

const partsOf = (parsed: ParsedMail, types: string[]) => parsed.attachments.filter((a) => types.includes(a.contentType.toLowerCase()));

function isDsnReport(parsed: ParsedMail): boolean {
  const ct = parsed.headers.get("content-type") as { value?: string; params?: Record<string, string> } | undefined;
  return ct?.value?.toLowerCase() === "multipart/report" && ct.params?.["report-type"]?.toLowerCase() === "delivery-status";
}

export function isBounce(parsed: ParsedMail): boolean {
  if (isDsnReport(parsed) || header(parsed, "x-failed-recipients")) return true;
  const from = fromAddressOf(parsed) ?? "";
  if (BOUNCE_SENDER.test(from) && partsOf(parsed, ["message/delivery-status"]).length) return true;
  // "Undeliverable" is a bounce, never an auto-reply.
  return BOUNCE_SUBJECT.test(parsed.subject ?? "");
}

/** Reads the first recipient block of the delivery-status part, else the X-Failed-Recipients / body fallbacks. */
export function parseDsn(parsed: ParsedMail): Dsn {
  const report = partsOf(parsed, ["message/delivery-status"])[0]?.content.toString("utf8") ?? "";
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "im").exec(report)?.[1]?.trim() ?? null;
  const original = partsOf(parsed, ["message/rfc822", "text/rfc822-headers", "message/rfc822-headers"])[0]?.content.toString("utf8") ?? "";
  const text = parsed.text ?? "";

  const statusField = field("Status");
  const action = field("Action")?.toLowerCase() ?? null;
  const diagnosticRaw = field("Diagnostic-Code");
  const status = ENHANCED.exec(statusField ?? "")?.[1] ?? ENHANCED.exec(diagnosticRaw ?? "")?.[1] ?? ENHANCED.exec(text)?.[1] ?? (action === "delayed" ? "4.0.0" : "5.0.0");
  const recipient = (field("Final-Recipient") ?? field("Original-Recipient"))?.replace(/^rfc822;\s*/i, "") ?? (header(parsed, "x-failed-recipients").split(",")[0]?.trim() || null);
  const originalMessageId = MESSAGE_ID_LINE.exec(original)?.[1] ?? MESSAGE_ID_LINE.exec(text)?.[1] ?? null;
  return {
    status,
    permanent: status.startsWith("5") && action !== "delayed",
    recipient: recipient?.replace(/[<>]/g, "").trim().toLowerCase() || null,
    originalMessageId,
    diagnostic: diagnosticRaw ? diagnosticRaw.replace(/^smtp;\s*/i, "").replace(/\s+/g, " ").slice(0, 300) : null,
  };
}

// ---------------------------------------------------------------------------
// Auto-replies (rule 3b), unsubscribes (3c), own / no-reply senders (3d)

const AUTO_SUBJECT = /^\s*(automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|out of (the )?office|away)\b/i;
const AUTO_PRECEDENCE = new Set(["auto_reply", "bulk", "junk", "list"]);

export function isAutoReply(parsed: ParsedMail): boolean {
  const auto = header(parsed, "auto-submitted").trim().toLowerCase();
  if (auto && auto !== "no") return true;
  if (header(parsed, "x-autoreply") || header(parsed, "x-autorespond")) return true;
  if (AUTO_PRECEDENCE.has(header(parsed, "precedence").trim().toLowerCase())) return true;
  if (header(parsed, "list-id")) return true;
  return AUTO_SUBJECT.test(parsed.subject ?? "");
}

const NO_REPLY = /^(no-?reply|do-?not-?reply|donotreply)([+.-][^@]*)?@/i;

export function isOwnOrNoReply(from: string | null, ownAddresses: string[]): boolean {
  if (!from) return true;
  const address = from.trim().toLowerCase();
  return ownAddresses.some((a) => a.trim().toLowerCase() === address) || NO_REPLY.test(address);
}

/** The workspace's own addresses: the from address and the reply-to (our List-Unsubscribe mailto). */
export interface OwnMailbox {
  fromAddress: string;
  replyTo: string;
}

export function classifyInboundEmail(parsed: ParsedMail, own: OwnMailbox): { kind: InboundEmailKind; dsn?: Dsn } {
  if (isBounce(parsed)) {
    const dsn = parseDsn(parsed);
    return { kind: dsn.permanent ? "bounce" : "bounce_temporary", dsn };
  }
  if (isAutoReply(parsed)) return { kind: "auto_reply" };
  const ownAddresses = [own.fromAddress, own.replyTo];
  const from = fromAddressOf(parsed);
  if (isOwnOrNoReply(from, ownAddresses)) return { kind: "ignored" };
  const recipients = [...addressesOf(parsed.to), ...addressesOf(parsed.cc)];
  const toUnsubscribe = recipients.includes(own.replyTo.trim().toLowerCase());
  if (toUnsubscribe && (parsed.subject ?? "").trim().toLowerCase() === "unsubscribe") return { kind: "unsubscribe" };
  return { kind: "reply" };
}

// ---------------------------------------------------------------------------
// Matching ids (rule 4)

const normalizeId = (id: string) => {
  const trimmed = id.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
};

/** In-Reply-To first, then each References id (newest first), de-duplicated. */
export function candidateMessageIds(parsed: ParsedMail): { id: string; method: "in_reply_to" | "references" }[] {
  const out: { id: string; method: "in_reply_to" | "references" }[] = [];
  const seen = new Set<string>();
  const add = (raw: string, method: "in_reply_to" | "references") => {
    for (const piece of raw.match(/<[^>\s]+>/g) ?? [raw]) {
      const id = normalizeId(piece);
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push({ id, method });
      }
    }
  };
  if (parsed.inReplyTo) add(parsed.inReplyTo, "in_reply_to");
  const refs = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  for (const ref of [...refs].reverse()) add(ref, "references");
  return out;
}

// ---------------------------------------------------------------------------
// Reply text (rule 5)

const QUOTE_STARTS: RegExp[] = [
  /^-{2,}\s*original message\s*-{2,}\s*$/im,
  /^_{10,}\s*$/m,
  // Gmail / Apple: "On <date>, <name> <addr> wrote:" (Gmail may wrap it over two lines).
  /^on\s[^\n]{0,300}(\n[^\n]{0,200})?\swrote:\s*$/im,
  /^le\s[^\n]{0,300}\sa écrit\s*:\s*$/im,
];

/** Outlook's "From: … / Sent: …" header block (no separator line). */
const OUTLOOK_BLOCK = /^from:\s.+\n(?:.*\n){0,2}?(sent|date):\s.+$/im;

function stripQuotedText(text: string): string {
  let body = text.replace(/\r\n?/g, "\n");
  let cut = body.length;
  for (const re of [...QUOTE_STARTS, OUTLOOK_BLOCK]) {
    const m = re.exec(body);
    if (m && m.index < cut) cut = m.index;
  }
  body = body.slice(0, cut);
  return body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Gmail / Outlook / Apple HTML quote containers are dropped before converting. */
function stripHtmlQuotes(html: string): string {
  return html
    .replace(/<div[^>]*class=["'][^"']*gmail_quote[\s\S]*$/i, "")
    .replace(/<div[^>]*id=["'](divRplyFwdMsg|appendonsend)["'][\s\S]*$/i, "")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "");
}

export interface ReplyText {
  subject: string;
  text: string;
  truncated: boolean;
}

/** The plain-text part (else the HTML converted), quoted history stripped, ≤ 4,000 code points. Never log it. */
export function extractReplyText(parsed: ParsedMail): ReplyText {
  const raw = parsed.text?.trim() ? parsed.text : typeof parsed.html === "string" ? htmlToText(stripHtmlQuotes(parsed.html)) : "";
  const stripped = stripQuotedText(raw);
  const points = Array.from(stripped);
  const truncated = points.length > MAX_REPLY_CHARS;
  return { subject: (parsed.subject ?? "").trim().slice(0, 300), text: truncated ? points.slice(0, MAX_REPLY_CHARS).join("") : stripped, truncated };
}
