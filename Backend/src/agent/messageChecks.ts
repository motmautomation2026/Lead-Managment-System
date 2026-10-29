import type { AgentDecision } from "./decisionSchema.js";

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
  rule: "banned_phrase" | "length" | "one_question" | "compound_question" | "exclamation";
  message: string;
}

/** E2b rule 1: the deterministic writing checks for a send decision (nothing for other actions). */
export function checkMessage(decision: AgentDecision, settings: MessageCheckSettings): MessageViolation[] {
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
  return violations;
}
