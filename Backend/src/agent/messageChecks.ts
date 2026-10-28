// URLs can carry "?" (query strings); they are not questions.
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

/** Questions in a message: runs of "?" (ASCII or full-width) outside URLs, so "Really?!" and "Why??" count once. */
export function countQuestions(text: string): number {
  return (text.replace(URL_RE, " ").match(/[?？]+/g) ?? []).length;
}
