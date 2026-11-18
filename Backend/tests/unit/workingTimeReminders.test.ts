import { describe, expect, it } from "vitest";
import { addWorkingTime, isDateOnly, lastWorkingSlotAtOrBefore, nextWorkingSlot } from "../../src/domain/workingTime.js";
import {
  dueBellAt,
  escalationBellTitle,
  firstCallDueAt,
  reminderAction,
  reminderEmail,
  reminderSendAt,
  reminderWhatsApp,
  taskEscalation,
  textToHtml,
} from "../../src/domain/reminders.js";

const ist = (local: string) => new Date(`${local}:00+05:30`);
const HOUR = 3_600_000;
// 2026-11-14 is a Saturday, 2026-11-15 a Sunday, 2026-11-16 a Monday.

describe("LL-2 working time (Mon–Sat 09:30–19:00 IST)", () => {
  it("Saturday night + 1 working hour → Monday 10:30", () => {
    expect(addWorkingTime(ist("2026-11-14T22:00"), HOUR)).toEqual(ist("2026-11-16T10:30"));
  });
  it("Sunday → the Monday opening", () => {
    expect(nextWorkingSlot(ist("2026-11-15T12:00"))).toEqual(ist("2026-11-16T09:30"));
    expect(addWorkingTime(ist("2026-11-15T12:00"), 2 * HOUR)).toEqual(ist("2026-11-16T11:30"));
  });
  it("18:45 + 1 h → the next working day 10:15 (Saturday 18:45 → Monday)", () => {
    expect(addWorkingTime(ist("2026-11-17T18:45"), HOUR)).toEqual(ist("2026-11-18T10:15"));
    expect(addWorkingTime(ist("2026-11-14T18:45"), HOUR)).toEqual(ist("2026-11-16T10:15"));
  });
  it("1 working day = 9.5 working hours", () => {
    expect(addWorkingTime(ist("2026-11-17T10:00"), 9.5 * HOUR)).toEqual(ist("2026-11-18T10:00"));
  });
  it("holidays are not supported: a weekday holiday counts as working time", () => {
    // 2026-11-24 (Tuesday) is treated like any Tuesday.
    expect(nextWorkingSlot(ist("2026-11-24T10:00"))).toEqual(ist("2026-11-24T10:00"));
  });
  it("last working slot at or before a time", () => {
    expect(lastWorkingSlotAtOrBefore(ist("2026-11-17T12:00"))).toEqual(ist("2026-11-17T12:00"));
    expect(lastWorkingSlotAtOrBefore(ist("2026-11-17T21:00"))).toEqual(ist("2026-11-17T18:45"));
    expect(lastWorkingSlotAtOrBefore(ist("2026-11-17T08:00"))).toEqual(ist("2026-11-16T18:45"));
    // Sunday and Monday early morning → Saturday 18:45.
    expect(lastWorkingSlotAtOrBefore(ist("2026-11-15T10:00"))).toEqual(ist("2026-11-14T18:45"));
    expect(lastWorkingSlotAtOrBefore(ist("2026-11-16T09:00"))).toEqual(ist("2026-11-14T18:45"));
  });
  it("date-only due times are 00:00 or 23:59 IST", () => {
    expect(isDateOnly(ist("2026-11-17T23:59"))).toBe(true);
    expect(isDateOnly(ist("2026-11-17T00:00"))).toBe(true);
    expect(isDateOnly(ist("2026-11-17T15:00"))).toBe(false);
  });
});

describe("LL-2 task rules", () => {
  it("first call: website lead due 1 working hour after creation", () => {
    expect(firstCallDueAt(ist("2026-11-14T22:00"))).toEqual(ist("2026-11-16T10:30"));
    expect(firstCallDueAt(ist("2026-11-17T11:00"))).toEqual(ist("2026-11-17T12:00"));
  });
  it("due bell: 15 min before a timed task; the day's opening for a date-only one", () => {
    expect(dueBellAt(ist("2026-11-17T15:00"))).toEqual(ist("2026-11-17T14:45"));
    expect(dueBellAt(ist("2026-11-17T23:59"))).toEqual(ist("2026-11-17T09:30"));
    expect(dueBellAt(ist("2026-11-15T23:59"))).toEqual(ist("2026-11-16T09:30"));
  });
  it("overdue escalation after 1 working day; reply tasks never", () => {
    const task = { title: "Send the brochure", dueAt: ist("2026-11-17T10:00"), replyTask: false };
    expect(taskEscalation(task, ist("2026-11-18T09:59"))).toBeNull();
    expect(taskEscalation(task, ist("2026-11-18T10:00"))).toBe("overdue");
    expect(taskEscalation({ ...task, replyTask: true }, ist("2026-11-25T10:00"))).toBeNull();
  });
  it("first-call escalation 1 working hour after due", () => {
    const task = { title: "First call", dueAt: ist("2026-11-16T10:30"), replyTask: false };
    expect(taskEscalation(task, ist("2026-11-16T11:29"))).toBeNull();
    expect(taskEscalation(task, ist("2026-11-16T11:30"))).toBe("first_call");
  });
  it("escalation titles", () => {
    expect(escalationBellTitle("overdue", { title: "Call back", leadName: "Asha Rao", ownerName: "Ravi" })).toBe("Overdue: Call back — Ravi");
    expect(escalationBellTitle("first_call", { title: "First call", leadName: "Asha Rao", ownerName: null })).toBe("New lead not called yet: Asha Rao — no owner");
  });
});

describe("LL-2 meeting reminder schedule", () => {
  const booked = ist("2026-11-10T10:00");
  it("24 h inside working time → exactly 24 h before", () => {
    expect(reminderSendAt("24h", ist("2026-11-18T15:00"), booked)).toEqual(ist("2026-11-17T15:00"));
  });
  it("24 h outside working time → the last slot before it", () => {
    // Monday 10:00 meeting: 24 h before = Sunday 10:00 → Saturday 18:45.
    expect(reminderSendAt("24h", ist("2026-11-16T10:00"), booked)).toEqual(ist("2026-11-14T18:45"));
    // Wednesday 08:00 meeting: Tuesday 08:00 → Monday 18:45.
    expect(reminderSendAt("24h", ist("2026-11-18T08:00"), booked)).toEqual(ist("2026-11-16T18:45"));
  });
  it("booked < 24 h ahead → 24 h skipped, 1 h kept", () => {
    const at = ist("2026-11-18T15:00");
    expect(reminderSendAt("24h", at, ist("2026-11-17T20:00"))).toBeNull();
    expect(reminderSendAt("1h", at, ist("2026-11-17T20:00"))).toEqual(ist("2026-11-18T14:00"));
  });
  it("the earlier slot passed at booking → skipped", () => {
    // Monday 10:00 meeting booked Sunday morning: the Saturday slot already passed.
    expect(reminderSendAt("24h", ist("2026-11-16T10:00"), ist("2026-11-15T09:00"))).toBeNull();
  });
  it("booked < 1 h ahead → both skipped", () => {
    const at = ist("2026-11-18T15:00");
    expect(reminderSendAt("24h", at, ist("2026-11-18T14:30"))).toBeNull();
    expect(reminderSendAt("1h", at, ist("2026-11-18T14:30"))).toBeNull();
  });
  it("worker action: wait, send, skip when too late", () => {
    const at = ist("2026-11-18T15:00");
    expect(reminderAction("24h", at, booked, ist("2026-11-17T14:00"))).toBe("wait");
    expect(reminderAction("24h", at, booked, ist("2026-11-17T15:05"))).toBe("send");
    expect(reminderAction("24h", at, booked, ist("2026-11-18T14:10"))).toBe("skip");
    expect(reminderAction("1h", at, booked, ist("2026-11-18T14:10"))).toBe("send");
    expect(reminderAction("1h", at, booked, ist("2026-11-18T15:00"))).toBe("skip");
  });
});

describe("LL-2 reminder texts (fixed, no AI)", () => {
  const base = { firstName: "Asha", meetingAt: ist("2026-11-18T15:00"), link: "https://meet.google.com/abc-defg-hij", repName: "Ravi Kumar" };
  it("email 24 h", () => {
    const mail = reminderEmail({ ...base, kind: "24h", sendAt: ist("2026-11-17T15:00") });
    expect(mail.subject).toBe("Reminder: our meeting on Wednesday, 18 November at 3:00 pm IST");
    expect(mail.text).toBe(
      "Hi Asha,\n\nA quick reminder of our meeting tomorrow, Wednesday, 18 November at 3:00 pm IST.\n\nJoin here: https://meet.google.com/abc-defg-hij\n\nSee you then,\nRavi Kumar",
    );
  });
  it("WhatsApp 1 h, no link, no first name", () => {
    expect(reminderWhatsApp({ ...base, firstName: null, link: null, kind: "1h", sendAt: ist("2026-11-18T14:00") })).toBe(
      "Hello, a quick reminder of our meeting in about an hour, at 3:00 pm IST.\n— Ravi Kumar",
    );
  });
  it("a 24 h reminder moved to Saturday says the day", () => {
    const text = reminderWhatsApp({ ...base, kind: "24h", meetingAt: ist("2026-11-16T10:00"), sendAt: ist("2026-11-14T18:45") });
    expect(text).toContain("our meeting on Monday, 16 November at 10:00 am IST.");
  });
  it("HTML escapes and links", () => {
    expect(textToHtml("Hi <b>\n\nJoin here: https://x.test/a")).toBe('<p>Hi &lt;b&gt;</p><p>Join here: <a href="https://x.test/a">https://x.test/a</a></p>');
  });
});
