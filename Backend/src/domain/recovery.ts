/**
 * LL-3 rules 3, 4, 6, 7 (pure): loss reasons and their recovery date, discard reasons, the "We tried calling"
 * WhatsApp text. Recovery and reminders land at 09:30 IST on a working day (domain/workingTime.ts).
 */
import type { LeadLossReason } from "./enums.js";
import { istDate, nextWorkingSlot } from "./workingTime.js";

/** The reasons offered for a new loss (Not interested, Mark Lost, deal Lost). Older values stay valid on old rows. */
export const LOSS_REASON_CHOICES = [
  "price_budget",
  "no_requirement",
  "existing_supplier",
  "competitor_selected",
  "no_response",
  "project_postponed",
  "other",
] as const satisfies readonly LeadLossReason[];

export const LOSS_REASON_LABELS: Record<LeadLossReason, string> = {
  price_budget: "Budget",
  no_requirement: "No requirement",
  existing_supplier: "Existing supplier",
  competitor_selected: "Competitor",
  no_response: "No response",
  project_postponed: "Postponed",
  other: "Other",
  internal_hiring: "Internal hiring",
  management_rejected: "Management rejected",
  no_urgency: "No urgency",
};

/**
 * Days after the loss until the lead comes back (rule 6). Postponed = the project date (null here). Older reasons:
 * internal hiring is treated like an existing supplier (90), management rejected / no urgency like no requirement (60).
 */
export const RECOVERY_DAYS: Record<LeadLossReason, number | null> = {
  price_budget: 30,
  no_requirement: 60,
  existing_supplier: 90,
  competitor_selected: 120,
  no_response: 30,
  project_postponed: null,
  other: 60,
  internal_hiring: 90,
  management_rejected: 60,
  no_urgency: 60,
};

export interface LossDetails {
  competitorName?: string | null;
  /** "YYYY-MM-DD", required for project_postponed. */
  projectDate?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Why the loss details are not acceptable, or null. */
export function lossDetailsProblem(reason: LeadLossReason, details: LossDetails, now: Date): string | null {
  if (reason !== "project_postponed") return null;
  const date = details.projectDate ?? "";
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) return "A project date is required when the project is postponed.";
  if (date <= istDate(now)) return "The project date must be in the future.";
  return null;
}

/** 09:30 IST on `date` ("YYYY-MM-DD"), or the next working slot when that day is a Sunday. */
export function workingMorningOf(date: string): Date {
  return nextWorkingSlot(new Date(`${date}T09:30:00+05:30`));
}

const addDaysToDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** When a lead lost at `lostAt` for `reason` comes back (09:30 IST, working day). */
export function recoverAt(reason: LeadLossReason, lostAt: Date, details: LossDetails = {}): Date {
  const days = RECOVERY_DAYS[reason];
  if (days === null) return workingMorningOf(details.projectDate ?? addDaysToDate(istDate(lostAt), 60));
  return workingMorningOf(addDaysToDate(istDate(lostAt), days));
}

/** "Re-engage: Asha Rao — lost 2026-11-17: Competitor (Acme)". */
export function recoveryTaskTitle(name: string, lostAt: Date, reason: LeadLossReason, competitorName?: string | null): string {
  const why = reason === "competitor_selected" && competitorName ? `${LOSS_REASON_LABELS[reason]} (${competitorName})` : LOSS_REASON_LABELS[reason];
  return `Re-engage: ${name} — lost ${istDate(lostAt)}: ${why}`.slice(0, 300);
}

/** Rule 7. */
export const DISCARD_REASONS = ["spam", "duplicate", "wrong_person", "not_a_sales_lead", "other"] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];
export const DISCARD_REASON_LABELS: Record<DiscardReason, string> = {
  spam: "Spam",
  duplicate: "Duplicate",
  wrong_person: "Wrong person",
  not_a_sales_lead: "Not a sales lead",
  other: "Other",
};

/** Rule 3: the fixed "We tried calling" WhatsApp (never AI). "just now" only on the day of the call. */
export function triedCallingText(input: { firstName: string | null; repName: string | null; workspaceName: string; calledAt: Date; now: Date }): string {
  const first = input.firstName?.trim().split(/\s+/)[0];
  const rep = input.repName?.trim().split(/\s+/)[0];
  const when = istDate(input.calledAt) === istDate(input.now) ? "just now" : "earlier";
  return [
    first ? `Hi ${first},` : "Hi,",
    `this is ${rep ?? "the team"} from ${input.workspaceName}.`,
    `I tried calling you ${when}. When is a good time to talk? You can also reply here.`,
  ].join(" ");
}
