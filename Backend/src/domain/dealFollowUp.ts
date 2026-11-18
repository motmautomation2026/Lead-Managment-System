/**
 * LL-3 rule 9 (pure): proposal validity, deal decision dates, the 10-day manager review, onboarding after Won.
 * Dates are IST calendar dates ("YYYY-MM-DD"); tasks land at 09:30 IST on working days (domain/workingTime.ts).
 */
import { istDate, workingDayOpening, WORKING_TIME } from "./workingTime.js";
import { workingMorningOf } from "./recovery.js";

const DAY_MS = 86_400_000;
export const PROPOSAL_VALID_DAYS = 30;
export const EXPIRY_WARNING_WORKING_DAYS = 3;
export const REVIEW_IDLE_DAYS = 10;
/** Deal stages that need a next decision date when a rep moves a deal into them. */
export const DECISION_DATE_STAGES = ["negotiation"] as const;

const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const isWorkingDate = (date: string) => workingDayOpening(new Date(`${date}T12:00:00+05:30`), WORKING_TIME) !== null;

/** Default valid-until: the sent date + 30 days. */
export function defaultValidUntil(sentAt: Date): string {
  return shiftDate(istDate(sentAt), PROPOSAL_VALID_DAYS);
}

/** 09:30 IST, 3 working days before the valid-until date: "Proposal expires <date> — follow up". */
export function expiryWarningAt(validUntil: string): Date {
  let date = validUntil;
  for (let left = EXPIRY_WARNING_WORKING_DAYS; left > 0; ) {
    date = shiftDate(date, -1);
    if (isWorkingDate(date)) left--;
  }
  return workingMorningOf(date);
}

/** The proposal (or decision) date has passed: the IST day after it has started. */
export function datePassed(date: string, now: Date): boolean {
  return istDate(now) > date;
}

/** Manager review: no stage change / call / note / meeting / message for > 10 days, at most once per 10 days. */
export function needsManagerReview(lastActivityAt: Date, lastReviewAt: Date | null, now: Date): boolean {
  const idle = now.getTime() - lastActivityAt.getTime() > REVIEW_IDLE_DAYS * DAY_MS;
  return idle && (!lastReviewAt || now.getTime() - lastReviewAt.getTime() >= REVIEW_IDLE_DAYS * DAY_MS);
}

/** Won → "Onboarding: <deal>" due at the next working day's opening. */
export function onboardingDueAt(wonAt: Date): Date {
  for (let day = 1; day <= 7; day++) {
    const opening = workingDayOpening(new Date(wonAt.getTime() + day * DAY_MS), WORKING_TIME);
    if (opening) return opening;
  }
  return wonAt;
}

export const proposalExpiringTitle = (validUntil: string) => `Proposal expires ${validUntil} — follow up`;
export const PROPOSAL_EXPIRED_TITLE = "Proposal expired — revise or close";
export const decisionOverdueTitle = (deal: string) => `Decision date passed: ${deal}`.slice(0, 300);
export const managerReviewTitle = (deal: string) => `Manager review: ${deal}`.slice(0, 300);
export const onboardingTitle = (deal: string) => `Onboarding: ${deal}`.slice(0, 300);

/** LL-3b rule 2: task markers of rule 9; on a Won lead these still get the due bell and overdue escalation. */
export const DEAL_FOLLOW_UP_MARKERS = ["onboarding", "proposal_expiring", "proposal_expired", "decision_overdue", "manager_review"] as const;
