import type { AgentContext } from "../services/agentContext.service.js";

/**
 * E2f rule 6: handoff/stop signals in what the contact told us (the website enquiry, the latest rep
 * call or note, the industry). Pure, keyword based, case-insensitive, whole words. The prompt shows
 * one neutral line per signal; the rules turn a send into the signalled action (rules.ts).
 */

export type SignalKind = "consumer" | "price" | "visit" | "ready";

export interface AgentSignal {
  kind: SignalKind;
  action: "handoff" | "stop";
  /** The lead_data line. */
  line: string;
  /** The closing-checklist line. */
  check: string;
  /** Handoff task title, or the stop reasoning. */
  title: string;
}

const WEEKDAYS = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)";
const words = (list: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join("|")})(?![\\p{L}\\p{N}])`, "iu");

// Most decisive first: a consumer business is stopped even if it also asked about price.
const SIGNALS: (AgentSignal & { re: RegExp; source: "enquiry" | "all" })[] = [
  {
    kind: "consumer",
    action: "stop",
    source: "enquiry",
    re: words(["bakery", "café", "cafe", "restaurant", "salon", "boutique", "retail shop", "walk-in customers", "walk-ins?", "individual"]),
    line: "Signal: this looks like a consumer business, not B2B — stop.",
    check: "- lead_data has a consumer-business signal: pick stop (not a B2B business), don't send a message.",
    title: "Not a B2B business",
  },
  {
    kind: "price",
    action: "handoff",
    source: "all",
    re: words(["price", "prices", "pricing", "charges", "cost", "costs", "fees", "quote", "rate card", "discount"]),
    line: "Signal: the contact asked about price — hand off.",
    check: "- lead_data has a price signal: pick handoff, don't answer about price in a message.",
    title: "Lead asked about price",
  },
  {
    kind: "visit",
    action: "handoff",
    source: "all",
    re: words(["visit", "visits", "visiting", "meet in person", "in person", "come to our factory", "come to our office"]),
    line: "Signal: the contact asked for a visit or in-person meeting — hand off; never offer or promise a visit.",
    check: "- lead_data has a visit signal: pick handoff; never offer or promise a visit.",
    title: "Lead asked for a visit or in-person meeting",
  },
  {
    kind: "ready",
    action: "handoff",
    source: "all",
    re: words([`call on ${WEEKDAYS}`, "call me", "schedule a call", "ready to", "send the proposal"]),
    line: "Signal: the contact is ready for a call or next step — hand off.",
    check: "- lead_data has a ready-for-next-step signal: pick handoff, don't send a message.",
    title: "Lead is ready for a call or next step",
  },
];

/** The signals in the given texts, most decisive first. `enquiry` = website enquiry + industry; `latest` = the latest rep call/note. */
export function detectSignals(texts: { enquiry: string; latest: string }): AgentSignal[] {
  const all = `${texts.enquiry}\n${texts.latest}`;
  return SIGNALS.filter((s) => s.re.test(s.source === "enquiry" ? texts.enquiry : all)).map(({ re: _re, source: _source, ...signal }) => signal);
}

/** The contact's signals from its context. */
export function signalsOf(ctx: Pick<AgentContext, "lead" | "company" | "timeline">): AgentSignal[] {
  const latest = [...ctx.timeline].reverse().find((t) => t.kind === "call" || t.kind === "note");
  const industry = (ctx.company ? ctx.company.industry : ctx.lead.industry) ?? "";
  return detectSignals({
    enquiry: `${ctx.lead.websiteMessage ?? ""}\n${industry}`,
    latest: latest ? `${latest.title}\n${latest.detail ?? ""}` : "",
  });
}
