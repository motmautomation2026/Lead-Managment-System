import type { AgentContext } from "../services/agentContext.service.js";
import type { AgentDecision } from "./decisionSchema.js";
import { situationInboundFirst, situationOf } from "./situation.js";
import { EMAIL_RE, PHONE_RE } from "./rules.js";

// URLs can carry "?" (query strings); they are not questions.
export const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const withoutUrls = (text: string) => text.replace(URL_RE, " ");

/** Questions in a message: runs of "?" (ASCII or full-width) outside URLs, so "Really?!" and "Why??" count once. */
export function countQuestions(text: string): number {
  return (withoutUrls(text).match(/[?？]+/g) ?? []).length;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const straightQuotes = (text: string) => text.replace(/[’‘]/g, "'");
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// E2f rule 5: a banned phrase right after one of these (within 3 words) is an honest "no", not a claim.
const NEGATIONS = new Set(["not", "cannot", "can't", "don't", "never", "no", "won't", "unable"]);
const negated = (before: string) => tokens(before).slice(-3).some((w) => NEGATIONS.has(w));

/** The banned phrases the text contains: case-insensitive, whole words (Unicode-aware), URLs ignored; an occurrence negated within 3 words ("we cannot guarantee") doesn't count. */
export function findBannedPhrases(text: string, phrases: readonly string[]): string[] {
  const clean = straightQuotes(withoutUrls(text));
  return phrases.filter((phrase) => {
    const trimmed = straightQuotes(phrase.trim());
    if (!trimmed) return false;
    const body = escapeRe(trimmed).replace(/\s+/g, "\\s+");
    const matches = clean.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu"));
    return [...matches].some((m) => !negated(clean.slice(0, m.index)));
  });
}

const SECOND_ASK = /\b(?:and|or),?\s+(?:how|what|which|when|where|why|who|do|does|did|can|could|would|will|is|are)\b/i;

/** The first question sentence that joins two asks ("…, and how do you…?"), or null. */
export function compoundQuestion(text: string): string | null {
  const sentences = withoutUrls(text).match(/[^.!?？\n]*[?？]/g) ?? [];
  // A sentence that starts with "And how…?" is one ask, not two joined.
  return sentences.map((s) => s.trim()).find((s) => (SECOND_ASK.exec(s)?.index ?? 0) > 0) ?? null;
}

// Things a file or building part can be, so "an attached garage" or "the attached plant" isn't a file.
const NOT_A_FILE = String.raw`(?:garage|bathroom|bath|building|house|room|office|plant|factory|warehouse|shed|workshop|space|area|motor|gearbox|cabin)\b`;
const FILE_WORD = String.raw`(?:case stud(?:y|ies)|documents?|pdfs?|brochures?|one[- ]pagers?|white ?papers?|presentations?|decks?|files?)\b`;
const ATTACHMENT_MENTIONS = [
  /\battach(?:ing|ments?)?\b/,
  // "attached to" is a file only with this email/message ("the team attached to the plant" isn't).
  new RegExp(String.raw`(?<!-)\battached\b(?!\s+(?:\w+\s+)?${NOT_A_FILE})(?!\s+to\b(?!\s+(?:this|the|my|our)\s+(?:e-?mail|mail|message)\b))`),
  new RegExp(String.raw`\benclos(?:ed|ing)\b(?!\s+(?:\w+\s+)?${NOT_A_FILE})`),
  /\bplease find\b(?!\s+(?:a|an|some)?\s*(?:good\s+|convenient\s+|suitable\s+)?(?:time|slot|date|moment)\b)/,
  // "I'm sharing a case study", "sending you a short PDF"; never across "your" ("thanks for sharing your document").
  new RegExp(String.raw`(?<!\bfor\s)\b(?:sharing|sending|forwarding)\b\s+(?:(?!your\b)[\w'-]+\s+){0,5}${FILE_WORD}`),
  new RegExp(String.raw`\b(?:i've|we've|i have|we have)\s+(?:shared|sent|included)\s+(?:(?!your\b)[\w'-]+\s+){0,5}${FILE_WORD}`),
  new RegExp(String.raw`\bhere(?:'s| is| are)\s+(?:[\w'-]+\s+){0,4}${FILE_WORD}`),
];

/** E2h rule 1: the text says a file is attached or being shared. Talking about client experience in words is not a mention. */
export function mentionsAttachment(text: string): boolean {
  const clean = withoutUrls(text).toLowerCase().replace(/[’‘]/g, "'");
  return ATTACHMENT_MENTIONS.some((re) => re.test(clean));
}

export interface MessageCheckSettings {
  banned_phrases: string[];
  email_max_words: number;
  whatsapp_max_words: number;
}

export interface MessageViolation {
  rule:
    | "banned_phrase"
    | "length"
    | "one_question"
    | "compound_question"
    | "exclamation"
    | "not_thanking_inbound"
    | "introduction_mid_conversation"
    | "internal_info_leak"
    | "attachment_mention"
    | "subject_style"
    | "contact_details";
  message: string;
}

/** E2c: what the conversation checks need to know about the contact (from code, never the model). */
export interface MessageFacts {
  /** First message to an inbound (website / form) lead with no conversation yet: it must thank them (E2d). */
  inboundFirst: boolean;
  /** A conversation exists: no introduction, no first-call ask. */
  conversationExists: boolean;
  ownerFirstName: string | null;
  companyName: string;
  /** Decide-only text (company description, open deal name) that must never be repeated. */
  internalTexts: string[];
  /** The lead's company: its name in capitals in a subject is fine. */
  leadCompany: string;
}

export function messageFactsOf(ctx: AgentContext): MessageFacts {
  const situation = situationOf(ctx);
  return {
    inboundFirst: situationInboundFirst(situation),
    conversationExists: situation.conversationExists,
    ownerFirstName: ctx.lead.ownerName?.trim().split(/\s+/)[0] ?? null,
    companyName: ctx.companyName,
    internalTexts: [ctx.internal.companyDescription, ctx.internal.deal.open?.name].filter((t): t is string => Boolean(t)),
    leadCompany: ctx.company?.name ?? ctx.lead.company,
  };
}

/** Lower-cased words, punctuation dropped (apostrophes inside words kept: "i'm"). */
const tokens = (text: string) => withoutUrls(text).toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
const contains = (words: string[], phrase: string) => ` ${words.join(" ")} `.includes(` ${tokens(phrase).join(" ")} `);

const THANKS_TARGETS = ["contacting", "reaching out", "getting in touch", "your enquiry", "your inquiry", "your interest", "writing to us", "filling", "submitting", "sharing"];

/** E2c rule 1: "thank you" / "thanks" followed within 6 words by a reason for reaching out. */
export function hasInboundThanks(text: string): boolean {
  const words = tokens(text);
  return words.some((word, i) => {
    const start = word === "thanks" ? i + 1 : word === "thank" && words[i + 1] === "you" ? i + 2 : -1;
    if (start < 0) return false;
    const window = words.slice(start, start + 6);
    return THANKS_TARGETS.some((target) => contains(window, target));
  });
}

/** E2c rule 2: introduction / first-call phrases the message uses, or []. */
export function introductionPhrases(text: string, facts: Pick<MessageFacts, "ownerFirstName" | "companyName">): string[] {
  const words = tokens(text);
  const owner = facts.ownerFirstName?.toLowerCase();
  const company = tokens(facts.companyName).find((w) => !STOP_WORDS.has(w));
  const phrases = [
    "thank you for reaching out",
    "thank you for contacting",
    ...(owner ? [`this is ${owner} from`, `i am ${owner} from`, `i'm ${owner} from`] : []),
    "introductory call",
    "introductory discussion",
    ...(company ? [`introduce ${company}`] : []),
    "introduce ourselves",
  ];
  return [...new Set(phrases)].filter((phrase) => contains(words, phrase));
}

// Common words: a run made only of these ("one of the best") is not a leak.
const STOP_WORDS = new Set(
  "a an the and or but of in on at to for from by with as is are was were be been being it its this that these those we our us you your they their them he she his her i my me not no so if than then too very can will would could should may might has have had do does did all any each more most other some such only own same just also into over under about after before between through during up down out off again further once here there when where why how what which who whom one two new".split(" "),
);
const LEAK_WORDS = 4;

/** E2c rule 3: runs of ≥ 4 consecutive words from the internal texts that appear in the message (not stop-words only). */
export function internalLeaks(text: string, internalTexts: readonly string[]): string[] {
  const grams = new Set<string>();
  for (const internal of internalTexts) {
    const words = tokens(internal);
    for (let i = 0; i + LEAK_WORDS <= words.length; i++) {
      const gram = words.slice(i, i + LEAK_WORDS);
      if (!gram.every((w) => STOP_WORDS.has(w))) grams.add(gram.join(" "));
    }
  }
  if (!grams.size) return [];
  const words = tokens(text);
  const leaks: string[] = [];
  for (let i = 0; i + LEAK_WORDS <= words.length; i++) {
    if (!grams.has(words.slice(i, i + LEAK_WORDS).join(" "))) continue;
    let end = i + LEAK_WORDS;
    while (end < words.length && grams.has(words.slice(end - LEAK_WORDS + 1, end + 1).join(" "))) end++;
    leaks.push(words.slice(i, end).join(" "));
    i = end - 1;
  }
  return [...new Set(leaks)];
}

const MAX_SUBJECT_CHARS = 60;
const MAX_SUBJECT_WORDS = 8;
// Four letters up, so CRM, ROI and B2B stay; company names (MOTM) are exempt.
const CAPS_WORD = /\p{Lu}{4,}/u;

/** E3a rule 6: what is wrong with a subject the model wrote, or null. */
export function subjectProblem(subject: string, companies: readonly string[]): string | null {
  const words = subject.split(/\s+/).filter(Boolean);
  if (subject.length > MAX_SUBJECT_CHARS) return `The subject has ${subject.length} characters; the limit is ${MAX_SUBJECT_CHARS}.`;
  if (words.length > MAX_SUBJECT_WORDS) return `The subject has ${words.length} words; the limit is ${MAX_SUBJECT_WORDS}.`;
  if (/^\s*(?:re|fwd?)\s*:/i.test(subject)) return 'Don\'t start the subject with "Re:" or "Fwd:".';
  const names = new Set(companies.flatMap((c) => c.split(/\s+/)).map((w) => w.toUpperCase()));
  const shouting = words.find((w) => w === w.toUpperCase() && CAPS_WORD.test(w) && !names.has(w.replace(/[^\p{L}\p{N}]/gu, "")));
  return shouting ? `Don't write words in all caps in the subject ("${shouting}").` : null;
}

/** E2b rule 1 + E2c: the deterministic writing checks for a send decision (nothing for other actions). */
export function checkMessage(decision: AgentDecision, settings: MessageCheckSettings, facts?: MessageFacts): MessageViolation[] {
  if (decision.action !== "send_email" && decision.action !== "send_whatsapp") return [];
  const violations: MessageViolation[] = [];
  const all = decision.action === "send_email" ? `${decision.subject}\n${decision.body}` : decision.body;

  const banned = findBannedPhrases(all, settings.banned_phrases);
  if (banned.length) violations.push({ rule: "banned_phrase", message: `Uses banned phrase(s): ${banned.map((p) => `"${p}"`).join(", ")}.` });

  const limit = decision.action === "send_email" ? settings.email_max_words : settings.whatsapp_max_words;
  const words = wordCount(decision.body);
  if (words > limit) violations.push({ rule: "length", message: `${words} words; the limit is ${limit}.` });

  const questions = countQuestions(decision.body);
  if (questions > 1) violations.push({ rule: "one_question", message: `The message asks ${questions} questions; ask at most one.` });
  const contacts = [...(all.match(URL_RE) ?? []), ...(all.match(EMAIL_RE) ?? []), ...(all.match(PHONE_RE) ?? []).filter((p) => p.replace(/\D/g, "").length >= 10)];
  // E3a rule 3: polish removes these when it can; what is left needs a rewrite.
  if (contacts.length) violations.push({ rule: "contact_details", message: `Don't write links, email addresses or phone numbers (${contacts.join(", ")}); the system adds what is needed.` });

  if (decision.action === "send_email") {
    const subject = subjectProblem(decision.subject, facts ? [facts.companyName, facts.leadCompany] : []);
    if (subject) violations.push({ rule: "subject_style", message: subject });
  }

  const compound = compoundQuestion(decision.body);
  if (compound) violations.push({ rule: "compound_question", message: `The question asks two things at once: "${compound}". Ask about one thing only.` });

  if (/[!！]/.test(withoutUrls(all))) violations.push({ rule: "exclamation", message: "Contains an exclamation mark; keep the tone calm." });

  // E2h rule 1: `decision` is the rules' final decision, so assetIds is what will really be attached.
  if (!decision.assetIds.length && mentionsAttachment(all)) {
    violations.push({ rule: "attachment_mention", message: "No file will be attached to this message. Do not mention an attachment, a case study being shared, or a PDF." });
  }

  if (!facts) return violations;
  if (facts.inboundFirst && !hasInboundThanks(decision.body)) {
    violations.push({ rule: "not_thanking_inbound", message: 'This is the first message to an inbound lead: thank them for reaching out (e.g. "Thank you for contacting us").' });
  }
  if (facts.conversationExists) {
    const intro = introductionPhrases(all, facts);
    if (intro.length) {
      violations.push({
        rule: "introduction_mid_conversation",
        message: `A conversation already exists: don't introduce us again or ask for a first call (${intro.map((p) => `"${p}"`).join(", ")}).`,
      });
    }
  }
  const leaks = internalLeaks(all, facts.internalTexts);
  if (leaks.length) violations.push({ rule: "internal_info_leak", message: `Repeats internal information. Do not mention: ${leaks.map((p) => `"${p}"`).join(", ")}.` });
  return violations;
}
