/**
 * LL-2 pure rules: when a task's "due" bell goes, when an open task escalates to the admins, the first-call
 * due time, when a meeting reminder goes, and the fixed reminder texts (no AI). SQL: services/taskReminders.service.ts,
 * services/meetingReminders.service.ts.
 */
import { addWorkingTime, HOUR_MS, isDateOnly, lastWorkingSlotAtOrBefore, MINUTE_MS, nextWorkingSlot, workingDayOpening } from "./workingTime.js";

// --- Rule 2: tasks -------------------------------------------------------------------------------

export const FIRST_CALL_TITLE = "First call";
/** A task with a time of day gets its bell this long before it is due. */
export const DUE_BELL_LEAD_MS = 15 * MINUTE_MS;
/** Overdue by 1 working day (9.5 working hours) → the admins. */
export const OVERDUE_WORKING_MS = 9.5 * HOUR_MS;
/** A website / inbound lead's first call: due 1 working hour after creation; escalated 1 working hour after due. */
export const FIRST_CALL_WORKING_MS = HOUR_MS;

/** Rule 2: website / inbound "First call" due time (a lead at 22:00 Saturday → Monday 10:30). */
export function firstCallDueAt(createdAt: Date): Date {
  return addWorkingTime(createdAt, FIRST_CALL_WORKING_MS);
}

/**
 * When the "due" bell goes: a task with a time 15 min before it; a date-only task (00:00 / 23:59 IST) at
 * that day's working-time opening (a Sunday task: the next opening).
 */
export function dueBellAt(dueAt: Date): Date {
  if (!isDateOnly(dueAt)) return new Date(dueAt.getTime() - DUE_BELL_LEAD_MS);
  return workingDayOpening(dueAt) ?? nextWorkingSlot(dueAt);
}

export type TaskEscalation = "first_call" | "overdue";

/**
 * Rule 2: which escalation an open task is due for at `now`, or null. Reply tasks never (their own 2-working-hour
 * escalation); a first call 1 working hour after due; any other task 1 working day (9.5 h) after due.
 */
export function taskEscalation(task: { title: string; dueAt: Date; replyTask: boolean }, now: Date): TaskEscalation | null {
  if (task.replyTask) return null;
  const firstCall = task.title === FIRST_CALL_TITLE;
  const at = addWorkingTime(task.dueAt, firstCall ? FIRST_CALL_WORKING_MS : OVERDUE_WORKING_MS);
  if (now.getTime() < at.getTime()) return null;
  return firstCall ? "first_call" : "overdue";
}

export const dueBellTitle = (count: number, single?: { title: string; leadName: string }) =>
  count === 1 && single ? `Due now: ${single.title} — ${single.leadName}`.slice(0, 300) : `${count} tasks due now`;

export const escalationBellTitle = (kind: TaskEscalation, t: { title: string; leadName: string; ownerName: string | null }) =>
  (kind === "first_call"
    ? `New lead not called yet: ${t.leadName} — ${t.ownerName ?? "no owner"}`
    : `Overdue: ${t.title} — ${t.ownerName ?? "no owner"}`
  ).slice(0, 300);

// --- Rule 4: meetings ----------------------------------------------------------------------------

export type LeadReminderKind = "24h" | "1h";
export const REMINDER_OFFSET_MS: Record<LeadReminderKind, number> = { "24h": 24 * HOUR_MS, "1h": HOUR_MS };

/**
 * When a lead reminder goes, or null (skipped). `plannedFrom` = the booking / last reschedule: a reminder
 * whose time is before it is skipped (booked < 24 h / < 1 h ahead). The 24 h one must be in working time,
 * else the last working slot before it (skipped if that is before `plannedFrom`). The 1 h one ignores it.
 */
export function reminderSendAt(kind: LeadReminderKind, meetingAt: Date, plannedFrom: Date): Date | null {
  const at = new Date(meetingAt.getTime() - REMINDER_OFFSET_MS[kind]);
  if (at.getTime() < plannedFrom.getTime()) return null;
  if (kind === "1h") return at;
  const slot = lastWorkingSlotAtOrBefore(at);
  return slot.getTime() < plannedFrom.getTime() ? null : slot;
}

/**
 * What the worker does with a reminder at `now`: wait (not yet), send, or skip (never planned, or so late
 * that the next one is due: a 24 h reminder after the 1 h time, a 1 h one after the start).
 */
export function reminderAction(kind: LeadReminderKind, meetingAt: Date, plannedFrom: Date, now: Date): "wait" | "send" | "skip" {
  const at = reminderSendAt(kind, meetingAt, plannedFrom);
  if (!at) return "skip";
  if (now.getTime() < at.getTime()) return "wait";
  const tooLate = kind === "24h" ? meetingAt.getTime() - HOUR_MS : meetingAt.getTime();
  return now.getTime() >= tooLate ? "skip" : "send";
}

const IST = "Asia/Kolkata";
const dayText = (at: Date) => new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "long", day: "numeric", month: "long" }).format(at);
const timeText = (at: Date) => new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit", hour12: true }).format(at).toLowerCase();

export interface ReminderTextInput {
  kind: LeadReminderKind;
  firstName: string | null;
  meetingAt: Date;
  /** When the reminder goes out ("today" / "tomorrow" are relative to it). */
  sendAt: Date;
  link: string | null;
  repName: string | null;
}

const istDay = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(at);

/** "in about an hour, at 3:00 pm IST" / "tomorrow, Tuesday, 17 November at 10:30 am IST" / "on Monday, 17 November at …". */
function whenText(input: ReminderTextInput): string {
  const time = `${timeText(input.meetingAt)} IST`;
  if (input.kind === "1h") return `in about an hour, at ${time}`;
  const day = dayText(input.meetingAt);
  if (istDay(input.sendAt) === istDay(input.meetingAt)) return `today, ${day} at ${time}`;
  if (istDay(new Date(input.sendAt.getTime() + 24 * HOUR_MS)) === istDay(input.meetingAt)) return `tomorrow, ${day} at ${time}`;
  return `on ${day} at ${time}`;
}

const greetingOf = (firstName: string | null) => (firstName?.trim() ? `Hi ${firstName.trim()},` : "Hello,");

/** Fixed text (Govinda approves the wording): email reminder to the lead. */
export function reminderEmail(input: ReminderTextInput): { subject: string; text: string } {
  const lines = [
    greetingOf(input.firstName),
    "",
    `A quick reminder of our meeting ${whenText(input)}.`,
    ...(input.link ? ["", `Join here: ${input.link}`] : []),
    "",
    "See you then,",
    input.repName?.trim() || "The team",
  ];
  return { subject: `Reminder: our meeting on ${dayText(input.meetingAt)} at ${timeText(input.meetingAt)} IST`, text: lines.join("\n") };
}

/** Fixed text (Govinda approves the wording): WhatsApp reminder to the lead. */
export function reminderWhatsApp(input: ReminderTextInput): string {
  return [
    `${greetingOf(input.firstName)} a quick reminder of our meeting ${whenText(input)}.`,
    ...(input.link ? [`Join here: ${input.link}`] : []),
    `— ${input.repName?.trim() || "The team"}`,
  ].join("\n");
}

/** Rule 4 rep reminder (bell + email): "Meeting in 1 hour: <lead> at 3:00 pm IST". */
export const repReminderTitle = (leadName: string, meetingAt: Date) => `Meeting in 1 hour: ${leadName} at ${timeText(meetingAt)} IST`.slice(0, 300);

/** Plain text → minimal HTML (escaped, line breaks, links clickable). */
export function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<p>${escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

/** Rule 4: the meeting outcome task is created this long after the meeting's end. */
export const OUTCOME_TASK_AFTER_END_MS = 2 * HOUR_MS;
