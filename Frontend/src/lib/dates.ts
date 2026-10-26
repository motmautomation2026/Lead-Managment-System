export const APP_TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET = "+05:30";

export function nowIso() {
  return new Date().toISOString();
}
export function toIsoFromIst(date: string, time = "10:00:00") {
  return new Date(`${date}T${time}${IST_OFFSET}`).toISOString();
}
export function dateInputValue(daysFromToday = 0, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now.getTime() + daysFromToday * 86_400_000));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function addDays(days: number, time = "10:00:00") {
  return toIsoFromIst(dateInputValue(days), time);
}

/** Current IST wall-clock time as "HH:MM". */
export function istTimeValue(now = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

/** Today 10:00 IST while that is still ahead, else the next working day (Mon–Fri) at 10:00 (B13). */
export function defaultCallbackSlot(now = new Date()) {
  const today = dateInputValue(0, now);
  if (istTimeValue(now) < "10:00") return { date: today, time: "10:00" };
  for (let days = 1; ; days++) {
    const date = dateInputValue(days, now);
    const weekday = new Date(`${date}T12:00:00${IST_OFFSET}`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return { date, time: "10:00" };
  }
}
