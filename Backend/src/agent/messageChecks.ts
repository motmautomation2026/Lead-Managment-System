import type { AgentContext } from "../services/agentContext.service.js";
import type { AgentDecision } from "./decisionSchema.js";
import { situationOf } from "./situation.js";

// URLs can carry "?" (query strings); they are not questions.
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const withoutUrls = (text: string) => text.replace(URL_RE, " ");

/** Questions in a message: runs of "?" (ASCII or full-width) outside URLs, so "Really?!" and "Why??" count once. */
export function countQuestions(text: string): number {
  return (withoutUrls(text).match(/[?？]+/g) ?? []).length;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The banned phrases the text contains: case-insensitive, whole words (Unicode-aware), URLs ignored. */
export function findBannedPhrases(text: string, phrases: readonly string[]): string[] {
  const clean = withoutUrls(text);
  return phrases.filter((phrase) => {
    const trimmed = phrase.trim();
    if (!trimmed) return false;
    const body = escapeRe(trimmed).replace(/\s+/g, "\\s+");
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu").test(clean);
  });
}

const SECOND_ASK = /\b(?:and|or),?\s+(?:how|what|which|when|where|why|who|do|does|did|can|could|would|will|is|are)\b/i;

/** The first question sentence that joins two asks ("…, and how do you…?"), or null. */
export function compoundQuestion(text: string): string | null {
  const sentences = withoutUrls(text).match(/[^.!?？\n]*[?？]/g) ?? [];
  // A sentence that starts with "And how…?" is one ask, not two joined.
  return sentences.map((s) => s.trim()).find((s) => (SECOND_ASK.exec(s)?.index ?? 0) > 0) ?? null;
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
    | "internal_info_leak";
  message: string;
}

/** E2c: what the conversation checks need to know about the contact (from code, never the model). */
export interface MessageFacts {
  /** First message to an inbound (website / form) lead: it must thank them. */
  inboundFirst: boolean;
  /** A conversation exists: no introduction, no first-call ask. */
  conversationExists: boolean;
  ownerFirstName: string | null;
  companyName: string;
  /** Decide-only text (company description, open deal name) that must never be repeated. */
  internalTexts: string[];
}

export function messageFactsOf(ctx: AgentContext): MessageFacts {
  const situation = situationOf(ctx);
  return {
    inboundFirst: situation.inbound && situation.firstMessage,
    conversationExists: situation.conversationExists,
    ownerFirstName: ctx.lead.ownerName?.trim().split(/\s+/)[0] ?? null,
    companyName: ctx.companyName,
    internalTexts: [ctx.internal.companyDescription, ctx.internal.deal.open?.name].filter((t): t is string => Boolean(t)),
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

/** E2c rule 2: introduction / first-call phrases the message uses, or [] (thanks phrases skipped when thanks are required). */
export function introductionPhrases(text: string, facts: Pick<MessageFacts, "ownerFirstName" | "companyName" | "inboundFirst">): string[] {
  const words = tokens(text);
  const owner = facts.ownerFirstName?.toLowerCase();
  const company = tokens(facts.companyName).find((w) => !STOP_WORDS.has(w));
  const phrases = [
    // An inbound first message must thank them (rule 1), so these are allowed then.
    ...(facts.inboundFirst ? [] : ["thank you for reaching out", "thank you for contacting"]),
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
  const compound = compoundQuestion(decision.body);
  if (compound) violations.push({ rule: "compound_question", message: `The question asks two things at once: "${compound}". Ask about one thing only.` });

  if (/[!！]/.test(withoutUrls(all))) violations.push({ rule: "exclamation", message: "Contains an exclamation mark; keep the tone calm." });

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
