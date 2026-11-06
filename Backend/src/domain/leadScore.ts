import { detectSignals } from "../agent/signals.js";
import { corporateDomain, isPlaceholderCompany } from "./companyNormalize.js";

/**
 * E3b-2b rule 15: the hot-lead score, 0–100 = enquiry (≤ 25) + fit (≤ 25) + engagement (≤ 50),
 * with a band and short reason codes. Pure: `now` is passed in. The score is for reps (lists,
 * the contact record); it is never given to the writer prompt.
 */

export type HotBand = "hot" | "warm" | "cold";

export interface LeadScoreInput {
  lifecycleState: string;
  /** The website enquiry text (timeline rawMessage), if any. */
  enquiry: string | null;
  email: string | null;
  company: string | null;
  /** The company's industry, else the contact's. */
  industry: string | null;
  revenueRange: string | null;
  /** The workspace's target industry keywords (lower case). */
  targetKeywords: readonly string[];
  /** Counted email opens (first_counted_open_at), any age; only the last 14 days count. */
  opens: readonly Date[];
  /** D4a labels of the contact's matched replies. */
  replies: readonly { label: string; at: Date }[];
  /** When meetings were booked (not cancelled). */
  meetings: readonly Date[];
  /** When proposals were sent. */
  proposals: readonly Date[];
  now: Date;
}

export interface LeadScore {
  score: number;
  band: HotBand;
  reasons: string[];
}

export const HOT_REASONS = [
  "closed",
  "stopped",
  "enquiry",
  "enquiry_detailed",
  "enquiry_need",
  "enquiry_signal",
  "consumer",
  "corporate_email",
  "company",
  "target_industry",
  "revenue",
  "opened",
  "opened_often",
  "replied",
  "replied_positive",
  "meeting",
  "proposal",
] as const;
export type HotReason = (typeof HOT_REASONS)[number];

const DAY = 86_400_000;
const ZERO_LIFECYCLES = ["do_not_contact", "lost", "won", "merged", "discarded"];
const STOP_LABELS = ["asked_to_stop", "not_interested", "annoyed"];
// A concrete need: what they sell or want (whole words, case-insensitive).
const NEED = /(?<![\p{L}\p{N}])(?:products?|markets?|buyers?|volumes?|exports?|exporting|importers?|distributors?|dealers?|customers?|clients?|orders?|leads?|sales)(?![\p{L}\p{N}])/iu;

export function bandOf(score: number): HotBand {
  return score >= 60 ? "hot" : score >= 30 ? "warm" : "cold";
}

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** A keyword matches the industry text as whole words ("epc" in "EPC contractor", not in "Depcon"). */
function matchesIndustry(industry: string, keywords: readonly string[]): boolean {
  const text = industry.toLowerCase();
  return keywords.some((k) => k.trim() && new RegExp(`(?<![\\p{L}\\p{N}])${k.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(text));
}

export function leadScore(input: LeadScoreInput): LeadScore {
  if (ZERO_LIFECYCLES.includes(input.lifecycleState)) return { score: 0, band: "cold", reasons: ["closed"] };
  if (input.replies.some((r) => STOP_LABELS.includes(r.label))) return { score: 0, band: "cold", reasons: ["stopped"] };
  const reasons: HotReason[] = [];
  const add = (points: number, reason: HotReason) => {
    if (points > 0) reasons.push(reason);
    return points;
  };

  // Enquiry (max 25).
  const enquiry = input.enquiry?.trim() ?? "";
  const signals = detectSignals({ enquiry: `${enquiry}\n${input.industry ?? ""}`, latest: "" }).map((s) => s.kind);
  let enquiryPoints = 0;
  if (enquiry) {
    enquiryPoints += add(5, "enquiry");
    if (words(enquiry) >= 15) enquiryPoints += add(5, "enquiry_detailed");
    if (NEED.test(enquiry)) enquiryPoints += add(5, "enquiry_need");
    if (signals.some((k) => k === "price" || k === "visit" || k === "ready")) enquiryPoints += add(10, "enquiry_signal");
  }

  // Fit (max 25); a consumer business has no fit.
  let fit = 0;
  if (signals.includes("consumer")) {
    reasons.push("consumer");
  } else {
    if (corporateDomain(input.email)) fit += add(5, "corporate_email");
    if (!isPlaceholderCompany(input.company)) fit += add(5, "company");
    if (input.industry && matchesIndustry(input.industry, input.targetKeywords)) fit += add(10, "target_industry");
    if (input.revenueRange?.trim()) fit += add(5, "revenue");
  }

  // Engagement (max 50): anything older than 30 days counts half.
  const now = input.now.getTime();
  const weight = (at: Date) => (now - at.getTime() > 30 * DAY ? 0.5 : 1);
  const best = (dates: readonly Date[]) => (dates.length ? Math.max(...dates.map(weight)) : 0);
  let engagement = 0;
  const opens = input.opens.filter((at) => now - at.getTime() <= 14 * DAY).length;
  if (opens >= 2) engagement += add(10, "opened_often");
  else if (opens === 1) engagement += add(5, "opened");
  const positive = input.replies.filter((r) => r.label === "positive").map((r) => r.at);
  const replied = input.replies.filter((r) => r.label === "question" || r.label === "other").map((r) => r.at);
  const positivePoints = 25 * best(positive);
  const repliedPoints = 15 * best(replied);
  if (positivePoints >= repliedPoints && positivePoints > 0) engagement += add(positivePoints, "replied_positive");
  else if (repliedPoints > 0) engagement += add(repliedPoints, "replied");
  if (input.meetings.length) engagement += add(20 * best(input.meetings), "meeting");
  if (input.proposals.length) engagement += add(10 * best(input.proposals), "proposal");

  const score = Math.round(Math.min(25, enquiryPoints) + Math.min(25, fit) + Math.min(50, engagement));
  return { score, band: bandOf(score), reasons };
}
