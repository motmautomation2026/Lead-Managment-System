import type { AgentDecision, SendDecision } from "./decisionSchema.js";
import { EMAIL_RE, PHONE_RE } from "./rules.js";
import { GENERIC_CLIENT_CLAIM, SENTENCE, URL_RE } from "./messageChecks.js";

/**
 * E3a rule 3: small writing problems are fixed by code, not rejected. Runs on subject + body
 * BEFORE the checks, so a fixed problem never causes a regeneration. A fix that would leave an
 * empty or broken sentence isn't made: the text stays and the normal check fails. Pure.
 */

export const AUTO_FIX_RULES = ["dash", "exclamation", "ellipsis", "sign_off", "contact_details", "spacing", "call_days", "generic_client_claim"] as const;
export type AutoFixRule = (typeof AUTO_FIX_RULES)[number];

export interface AutoFix {
  rule: AutoFixRule;
  before: string;
  after: string;
}

export interface PolishNames {
  ownerName: string | null;
  companyName: string;
  /** E3b-2b rule 4: the two suggested days ("Thursday or Friday"); null = no call-days fix. */
  suggestedDays?: string | null;
}

const CONTEXT = 20;
const excerpt = (text: string, start: number, end: number) => text.slice(Math.max(0, start - CONTEXT), end + CONTEXT).trim();

/** Replaces every match, recording each change with a little context. `replacement` null = leave this match. */
function replaceEach(text: string, re: RegExp, rule: AutoFixRule, fixes: AutoFix[], replacement: (match: string, offset: number) => string | null): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    const to = replacement(m[0], m.index);
    if (to === null || to === m[0]) continue;
    const end = m.index + m[0].length;
    out += text.slice(last, m.index) + to;
    last = end;
    const before = excerpt(text, m.index, end);
    fixes.push({ rule, before, after: `${text.slice(Math.max(0, m.index - CONTEXT), m.index)}${to}${text.slice(end, end + CONTEXT)}`.trim() });
  }
  return out + text.slice(last);
}

const isDigit = (c: string | undefined) => c !== undefined && /\d/.test(c);
const startsLine = (c: string | undefined) => c === undefined || c === "\n";

// " - " counts only with a space on both sides, so "follow-up" and "9-5" are never touched.
const DASH = /[ \t]*[—–]+[ \t]*|[ \t]+--?[ \t]+/g;

function fixDashes(text: string, fixes: AutoFix[]): string {
  return replaceEach(text, DASH, "dash", fixes, (match, at) => {
    const prev = text[at - 1];
    const next = text[at + match.length];
    if (isDigit(prev) && isDigit(next)) return null; // a range: 9–5, 10 - 20
    if (startsLine(prev)) return "";
    if (startsLine(next)) return /[\p{L}\p{N}]/u.test(prev!) ? "." : "";
    if (/[,.;:?!(]/.test(prev!)) return " ";
    // A new thought after a sentence's worth of words; else a pause ("Pune – Mumbai").
    const sentence = text.slice(0, at).split(/[.?!\n]/).pop()!;
    return next !== undefined && /\p{Lu}/u.test(next) && sentence.trim().split(/\s+/).length >= 4 ? ". " : ", ";
  });
}

const capitalised = (space: string | undefined) => (space ? space.toUpperCase() : "");

function fixExclamations(text: string, fixes: AutoFix[]): string {
  return replaceEach(text, /[!！]+(\s+\p{Ll})?/gu, "exclamation", fixes, (match, at) => {
    const following = match.replace(/^[!！]+/, "");
    const prev = text[at - 1];
    const next = text[at + match.length];
    return prev === "?" || next === "?" ? following : `.${capitalised(following)}`;
  });
}

function fixEllipses(text: string, fixes: AutoFix[]): string {
  return replaceEach(text, /[ \t]*(?:…|\.{3,})(\s+\p{Ll})?/gu, "ellipsis", fixes, (match, at) => {
    const following = match.replace(/^[ \t]*(?:…|\.+)/, "");
    const next = text[at + match.length];
    if (startsLine(text[at - 1])) return following.trimStart();
    return next !== undefined && /[.,;:?!]/.test(next) ? following : `.${capitalised(following)}`;
  });
}

/** Applies a text fix outside URLs (a URL that couldn't be removed keeps its "!" and "..."). */
function outsideUrls(text: string, fix: (part: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    out += fix(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fix(text.slice(last));
}

// Words that need what follows them: dropping the link after one breaks the sentence.
const NEEDS_NEXT = /(?:\b(?:at|on|to|via|visit|see|call|email|mail|whatsapp|from|here|is|are|website|site|link|number|address|our|your|the|or|and|with|by|for)|[:=])\s*$/i;

/** Where a link/address/number can go without breaking its sentence: alone on a line, in brackets, or tacked on after the sentence. */
function removalRange(text: string, start: number, end: number): [number, number] | null {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", end);
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd < 0 ? text.length : lineEnd);
  if (!before.trim() && /^[.,;:]*\s*$/.test(after)) return [lineStart, lineEnd < 0 ? text.length : lineEnd + 1];
  if (/\(\s*$/.test(before) && /^\s*\)/.test(after)) return [start - (before.length - before.trimEnd().length) - 1, end + after.indexOf(")") + 1];
  if (!/^[.,;:]*\s*$/.test(after) || NEEDS_NEXT.test(before)) return null;
  return [start, end];
}

function removeContacts(text: string, fixes: AutoFix[]): string {
  const found = [URL_RE, EMAIL_RE, PHONE_RE]
    .flatMap((re) => [...text.matchAll(re)].map((m) => ({ value: m[0].replace(/[.,;:!?)]+$/, ""), at: m.index })))
    .filter((f, _, all) => !all.some((o) => o !== f && o.at <= f.at && o.at + o.value.length >= f.at + f.value.length && o.value.length > f.value.length))
    .filter((f) => !/^[+\d]/.test(f.value) || f.value.replace(/\D/g, "").length >= 10)
    .sort((a, b) => b.at - a.at);
  let out = text;
  for (const { value, at } of found) {
    const range = removalRange(out, at, at + value.length);
    if (!range) continue;
    const next = `${out.slice(0, range[0]).replace(/[ \t]+$/, "")}${out.slice(range[1])}`;
    fixes.push({ rule: "contact_details", before: excerpt(out, at, at + value.length), after: excerpt(next, range[0], range[0]) });
    out = next;
  }
  return out;
}

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const SIGN_OFF = /^(?:(?:best|kind|warm|warmest)\s+regards|regards|thanks\s*(?:and|&)\s*regards|thanks|thank\s+you|cheers|best|sincerely|warmly|yours\s+(?:truly|sincerely))\b[\s,.!]*/i;

function fixSignOff(body: string, names: PolishNames, fixes: AutoFix[]): string {
  const known = new Set(wordsOf(`${names.ownerName ?? ""} ${names.companyName}`));
  const onlyNames = (line: string) => {
    const words = wordsOf(line);
    return words.length > 0 && words.length <= 8 && words.every((w) => known.has(w));
  };
  const lines = body.split("\n");
  let keep = lines.length;
  for (let i = lines.length - 1; i > 0; i--) {
    const line = lines[i]!.replace(/^[\s—–-]+/, "");
    if (!line.trim()) continue;
    const signOff = SIGN_OFF.exec(line);
    const rest = signOff ? line.slice(signOff[0].length) : line;
    if (!(signOff && !rest.trim()) && !onlyNames(rest)) break;
    keep = i;
  }
  if (keep === lines.length) return body;
  const kept = lines.slice(0, keep).join("\n").trimEnd();
  // Only a greeting left: not a message; the signature check fails instead.
  if (wordsOf(kept).length < 3) return body;
  fixes.push({ rule: "sign_off", before: lines.slice(keep).join(" ").trim(), after: "" });
  return kept;
}

function fixSpacing(text: string, fixes: AutoFix[]): string {
  const fixed = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (fixed !== text) fixes.push({ rule: "spacing", before: "repeated spaces or blank lines", after: "normalised" });
  return fixed;
}

// E3b-2b rule 4: time phrases removed when the message already offers both suggested days.
const VAGUE_PHRASE = "(?:in the coming days|in the next few days|in the coming week|sometime soon)";
const VAGUE_AT_START = new RegExp(String.raw`(^|[.!?][ \t]+|\n[ \t]*)${VAGUE_PHRASE},?[ \t]*(\p{L})`, "giu");
const VAGUE_IN_SENTENCE = new RegExp(String.raw`[ \t]*,?[ \t]+${VAGUE_PHRASE}\b`, "gi");

function fixCallDays(body: string, days: string | null | undefined, fixes: AutoFix[]): string {
  const offered = days?.split(" or ").every((day) => new RegExp(String.raw`\b${day}\b`, "i").test(body));
  if (!offered) return body;
  const fixed = body.replace(VAGUE_AT_START, (_m, before: string, next: string) => `${before}${next.toUpperCase()}`).replace(VAGUE_IN_SENTENCE, "");
  if (fixed !== body) fixes.push({ rule: "call_days", before: body.match(new RegExp(VAGUE_PHRASE, "i"))![0], after: "" });
  return fixed;
}

// E3b-2b rule 5: a general client-experience sentence goes when at least 2 other sentences stay; else the check fails.
function fixGenericClaims(body: string, fixes: AutoFix[]): string {
  const sentences = body.match(SENTENCE) ?? [];
  const generic = sentences.filter((s) => GENERIC_CLIENT_CLAIM.test(s));
  if (!generic.length || sentences.length - generic.length < 2) return body;
  let out = body;
  for (const sentence of generic) {
    out = out.replace(sentence, "");
    fixes.push({ rule: "generic_client_claim", before: sentence.trim(), after: "" });
  }
  // A paragraph that was only that sentence leaves an empty line; spacing collapses it.
  return out.replace(/^[ \t]+/gm, "");
}

function polishText(text: string, fixes: AutoFix[], signOff: (text: string, fixes: AutoFix[]) => string): string {
  const found: AutoFix[] = [];
  let out = removeContacts(text, found);
  out = signOff(out, found);
  out = outsideUrls(out, (part) => fixEllipses(fixExclamations(fixDashes(part, found), found), found));
  out = fixSpacing(out, found);
  if (!out.trim()) return text;
  fixes.push(...found);
  return out;
}

/** The decision with its subject and body auto-fixed, and what changed; other actions pass through. */
export function polishDecision(decision: AgentDecision, names: PolishNames): { decision: AgentDecision; autoFixes: AutoFix[] } {
  if (decision.action !== "send_email" && decision.action !== "send_whatsapp") return { decision, autoFixes: [] };
  const autoFixes: AutoFix[] = [];
  // Before the ellipsis fix, which would split a "…" inside a generic sentence.
  const body = polishText(fixCallDays(fixGenericClaims(decision.body, autoFixes), names.suggestedDays, autoFixes), autoFixes, (text, fixes) => fixSignOff(text, names, fixes));
  const polished: SendDecision =
    decision.action === "send_email" ? { ...decision, body, subject: polishText(decision.subject, autoFixes, (text) => text) } : { ...decision, body };
  return { decision: polished, autoFixes };
}
