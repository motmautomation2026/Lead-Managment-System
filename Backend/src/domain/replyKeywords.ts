/**
 * D4a rule 2: exact short phrases that need no AI. The WHOLE reply must be one
 * of these after lower-casing, dropping punctuation/emoji and collapsing
 * spaces; anything longer ("stop by tomorrow") is left to the AI step.
 */
export type KeywordLabel = "asked_to_stop" | "not_interested";

const STOP_PHRASES = [
  "stop",
  "stop it",
  "stop please",
  "please stop",
  "stop messages",
  "stop messaging",
  "stop messaging me",
  "stop sending",
  "stop sending messages",
  "unsubscribe",
  "remove me",
  "please remove me",
  "dont message me",
  "do not message",
  "do not message me",
  "dont contact me",
  "do not contact me",
  "opt out",
];

const NOT_INTERESTED_PHRASES = [
  "not interested",
  "im not interested",
  "i am not interested",
  "not interested thanks",
  "not interested thank you",
];

const PHRASES = new Map<string, KeywordLabel>([
  ...STOP_PHRASES.map((p) => [p, "asked_to_stop"] as const),
  ...NOT_INTERESTED_PHRASES.map((p) => [p, "not_interested"] as const),
]);

export function normalizeReply(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "") // "don't" → "dont"
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function matchReplyKeyword(text: string | null | undefined): KeywordLabel | null {
  if (!text) return null;
  return PHRASES.get(normalizeReply(text)) ?? null;
}

export const REPLY_KEYWORD_PHRASES: ReadonlyMap<string, KeywordLabel> = PHRASES;
