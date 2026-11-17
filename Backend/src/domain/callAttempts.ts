/**
 * LL-3 rule 2: the call retry ladder (pure; working time = domain/workingTime.ts). An unanswered call is attempt N
 * (consecutive unanswered calls, reset by a connected call, a lead reply or a booked meeting); the next call task is
 * "Call attempt N+1", due by the ladder below. After MAX_CALL_ATTEMPTS unanswered calls there is no next call task.
 */
import type { CallNotConnectedReason } from "./enums.js";
import { addWorkingTime, HOUR_MS, MINUTE_MS, nextWorkingSlot, workingDayOpening, WORKING_TIME } from "./workingTime.js";

export const MAX_CALL_ATTEMPTS = 5;
const DAY_MS = 24 * HOUR_MS;
const IST_OFFSET_MS = 330 * MINUTE_MS;
/** One working day: 09:30–19:00. */
const WORKING_DAY_MS = 9.5 * HOUR_MS;
/** Morning = 09:30–14:15 IST (the first half of working time), afternoon = after. */
const AFTERNOON_FROM_MS = 14 * HOUR_MS + 15 * MINUTE_MS;

/** A bad number stops the ladder ("Fix the phone number"); every other not-connected reason counts as No answer. */
export function isBadNumber(reason: CallNotConnectedReason): boolean {
  return reason === "wrong_number" || reason === "invalid_number";
}

/** The attempt number of a new unanswered call: previous + 1 unless something reset the counter since that call. */
export function nextAttemptNumber(previous: { attemptNumber: number | null } | null, resetSince: boolean): number {
  return previous?.attemptNumber && !resetSince ? previous.attemptNumber + 1 : 1;
}

/** End-of-day results (19:00) move to the next opening: a task is never due at closing time. */
const settle = (at: Date) => nextWorkingSlot(at);

/** The next working day (after `at`'s IST day) at the opening of the other half of the day than `at`. */
function nextWorkingDayOtherHalf(at: Date): Date {
  const clock = (at.getTime() + IST_OFFSET_MS) % DAY_MS;
  const afternoon = clock >= AFTERNOON_FROM_MS;
  for (let day = 1; day <= 7; day++) {
    const opening = workingDayOpening(new Date(at.getTime() + day * DAY_MS), WORKING_TIME);
    if (!opening) continue;
    // Opening is 09:30; the afternoon half starts 4 h 45 min later.
    return afternoon ? opening : new Date(opening.getTime() + AFTERNOON_FROM_MS - 9.5 * HOUR_MS);
  }
  return nextWorkingSlot(at);
}

/**
 * When "Call attempt `attempt + 1`" is due after unanswered call number `attempt` at `at`; null after the last one.
 * 1 → +2 working hours · 2 → next working day, other half · 3 → +2 working days · 4 → +4 working days · 5 → stop.
 */
export function nextAttemptDueAt(attempt: number, at: Date): Date | null {
  if (attempt <= 1) return settle(addWorkingTime(at, 2 * HOUR_MS));
  if (attempt === 2) return nextWorkingDayOtherHalf(at);
  if (attempt === 3) return settle(addWorkingTime(at, 2 * WORKING_DAY_MS));
  if (attempt === 4) return settle(addWorkingTime(at, 4 * WORKING_DAY_MS));
  return null;
}

export const callAttemptTitle = (attempt: number) => `Call attempt ${attempt}`;
/** "Attempt 3 of 5" (call task + call queue). */
export const attemptLabel = (attempt: number) => `Attempt ${attempt} of ${MAX_CALL_ATTEMPTS}`;
export const FIX_PHONE_TITLE = "Fix the phone number";
export const INTERESTED_LATER_CALLBACK_TITLE = "Call back — interested later";

export interface TriedCallingInput {
  enabled: boolean;
  hasPhone: boolean;
  lifecycle: string;
  /** A connected call, a matched reply or a booked meeting since the message was queued. */
  reached: boolean;
  /** AI real sends + earlier "tried calling" sends in the last 7 days (the 48 h gap does not apply). */
  touches7d: number;
  max7d: number;
  /** Earlier real "tried calling" sends to the lead, ever (own cap; not the AI's total limit). */
  triedCallingSent: number;
}

/** LL-3b rule 1: at most this many "We tried calling" messages per lead, ever (both numbers together). */
export const MAX_TRIED_CALLING_MESSAGES = 3;

/** Rule 3 at send time: why the queued "We tried calling" message is dropped, or null to send it. */
export function triedCallingCheck(f: TriedCallingInput): string | null {
  if (!f.enabled) return "The \"We tried calling\" WhatsApp is turned off.";
  if (!f.hasPhone) return "The contact no longer has a WhatsApp-capable phone number.";
  if (f.lifecycle !== "active" && f.lifecycle !== "long_term_nurture") return `The contact is ${f.lifecycle.replace(/_/g, " ")}.`;
  if (f.reached) return "The contact was reached meanwhile.";
  if (f.touches7d >= f.max7d) return `The contact already got ${f.max7d} messages in 7 days.`;
  if (f.triedCallingSent >= MAX_TRIED_CALLING_MESSAGES) return `The contact already got ${MAX_TRIED_CALLING_MESSAGES} "We tried calling" messages.`;
  return null;
}
