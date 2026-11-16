/**
 * LL-2 rule 1: working time = the normal send window, Mon–Sat 09:30–19:00 IST, no Sundays (one shared
 * definition: DEFAULT_SEND_WINDOW). Holidays are not supported: a public holiday counts as a working day.
 * Pure: no clock, no DB.
 */
import { DEFAULT_SEND_WINDOW, nextWindowTime, type SendWindow } from "./whatsappSafety.js";

export const WORKING_TIME: SendWindow = DEFAULT_SEND_WINDOW;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const IST_OFFSET_MS = 330 * MINUTE_MS;

const istMidnight = (at: Date) => Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
const clockMs = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return (h * 60 + m) * MINUTE_MS;
};
/** ISO weekday (1 = Monday) of the IST day starting at `midnight`. */
const isoWeekday = (midnight: number) => ((new Date(midnight + IST_OFFSET_MS).getUTCDay() + 6) % 7) + 1;

/** `at` when inside working time, else the next opening (no jitter). */
export function nextWorkingSlot(at: Date, window: SendWindow = WORKING_TIME): Date {
  return nextWindowTime(at, window, () => 0);
}

/** `from` plus `ms` of working time (only inside the window: its days and hours, IST). */
export function addWorkingTime(from: Date, ms: number, window: SendWindow = WORKING_TIME): Date {
  let at = nextWorkingSlot(from, window);
  let left = ms;
  for (let guard = 0; guard < 400; guard++) {
    const end = new Date(istMidnight(at) + clockMs(window.end));
    const available = end.getTime() - at.getTime();
    if (left <= available) return new Date(at.getTime() + left);
    left -= Math.max(available, 0);
    at = nextWorkingSlot(new Date(end.getTime() + 1), window);
  }
  return at;
}

/** Margin before the window closes for "the last window slot" (a send then still fits the day). */
export const LAST_SLOT_MARGIN_MS = 15 * MINUTE_MS;

/** `at` when inside working time, else the last working slot before it (the previous closing − 15 min). */
export function lastWorkingSlotAtOrBefore(at: Date, window: SendWindow = WORKING_TIME): Date {
  for (let day = 0; day < 8; day++) {
    const midnight = istMidnight(at) - day * DAY_MS;
    if (!window.days.includes(isoWeekday(midnight))) continue;
    const start = midnight + clockMs(window.start);
    const end = midnight + clockMs(window.end);
    if (day === 0 && at.getTime() >= start && at.getTime() < end) return at;
    if (day > 0 || at.getTime() >= end) return new Date(end - LAST_SLOT_MARGIN_MS);
  }
  return at;
}

/** An IST date-only due time (00:00 or 23:59): the task has no time of day. */
export function isDateOnly(dueAt: Date): boolean {
  const clock = (dueAt.getTime() + IST_OFFSET_MS) % DAY_MS;
  return clock === 0 || clock === 23 * HOUR_MS + 59 * MINUTE_MS;
}

/** "YYYY-MM-DD" of the IST day of `at`. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The IST day's working-time opening, or null on a non-working day (Sunday). */
export function workingDayOpening(at: Date, window: SendWindow = WORKING_TIME): Date | null {
  const midnight = istMidnight(at);
  return window.days.includes(isoWeekday(midnight)) ? new Date(midnight + clockMs(window.start)) : null;
}
