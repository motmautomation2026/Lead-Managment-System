import { describe, expect, it } from "vitest";
import type { Queryable } from "../../src/dto.js";
import {
  CLAIM_WHATSAPP_SQL,
  dueReminders,
  INSERT_REMINDER_SQL,
  PLAN_CANDIDATES_SQL,
  planMeeting,
  RESET_FROM_SQL,
  RESET_REMINDERS_SQL,
  resetMeetingReminders,
  usableChannels,
  type PlanRow,
} from "../../src/services/meetingReminders.service.js";
import { meetingTimeChanged } from "../../src/services/meetings.service.js";
import { safetySourceOf } from "../../src/providers/baileys.manager.js";
import { decideSend, DEFAULT_SEND_WINDOW } from "../../src/domain/whatsappSafety.js";
import { decideEmailSend, isAutomatedEmail } from "../../src/domain/emailSafety.js";

const ist = (local: string) => new Date(`${local}:00+05:30`);
const MEETING = ist("2026-11-18T15:00");

const meeting = (over: Partial<PlanRow> = {}): PlanRow => ({
  id: "m1",
  workspace_id: "ws-1",
  lead_id: "lead-1",
  owner_id: "owner-1",
  title: "Intro call",
  scheduled_at: MEETING,
  reminders_from: ist("2026-11-10T10:00"),
  link: "https://meet.google.com/abc-defg-hij",
  rep_name: "Ravi Kumar",
  first_name: "Asha",
  lead_name: "Asha Rao",
  email: "asha@example.com",
  phone_e164: "+919000000001",
  whatsapp_number_id: "num-1",
  email_status: null,
  whatsapp_status: "reachable",
  lead_reminders_enabled: true,
  done: [],
  ...over,
});

describe("LL-2 meeting reminders: what is due", () => {
  it("24 h before → email + WhatsApp; 1 h before → both + the rep", () => {
    expect(dueReminders(meeting(), ist("2026-11-17T15:00"))).toEqual([
      { kind: "24h", channel: "email" },
      { kind: "24h", channel: "whatsapp" },
    ]);
    expect(dueReminders(meeting({ done: ["24h:email", "24h:whatsapp"] }), ist("2026-11-18T14:00"))).toEqual([
      { kind: "1h", channel: "email" },
      { kind: "1h", channel: "whatsapp" },
      { kind: "rep_1h", channel: "staff" },
    ]);
  });

  it("nothing before its time; nothing twice (done markers)", () => {
    expect(dueReminders(meeting(), ist("2026-11-17T14:59"))).toEqual([]);
    expect(dueReminders(meeting({ done: ["24h:email", "24h:whatsapp"] }), ist("2026-11-17T16:00"))).toEqual([]);
  });

  it("booked < 24 h ahead: no 24 h reminder, the 1 h one still goes", () => {
    const late = meeting({ reminders_from: ist("2026-11-18T09:00") });
    expect(dueReminders(late, ist("2026-11-18T10:00"))).toEqual([]);
    expect(dueReminders(late, ist("2026-11-18T14:00")).map((r) => r.kind)).toEqual(["1h", "1h", "rep_1h"]);
  });

  it("opted-out / invalid channels and a phone without a sticky number are skipped", () => {
    expect(usableChannels(meeting({ whatsapp_status: "opted_out" }))).toEqual(["email"]);
    expect(usableChannels(meeting({ whatsapp_number_id: null }))).toEqual(["email"]);
    expect(usableChannels(meeting({ email_status: "unsubscribed" }))).toEqual(["whatsapp"]);
    expect(usableChannels(meeting({ email: null, phone_e164: null }))).toEqual([]);
  });

  it("workspace setting off → only the rep's reminder", () => {
    expect(dueReminders(meeting({ lead_reminders_enabled: false }), ist("2026-11-18T14:05"))).toEqual([{ kind: "rep_1h", channel: "staff" }]);
  });

  it("the candidates: scheduled meetings only, never DNC / merged leads, fair pick", () => {
    expect(PLAN_CANDIDATES_SQL).toContain("x.status = 'scheduled'");
    expect(PLAN_CANDIDATES_SQL).toContain("l.lifecycle_state not in ('do_not_contact', 'merged')");
    expect(PLAN_CANDIDATES_SQL).toContain("row_number() over (partition by x.workspace_id");
    expect(INSERT_REMINDER_SQL).toContain("on conflict (meeting_id, kind, channel, meeting_at) do nothing");
    expect(CLAIM_WHATSAPP_SQL).toContain("for update skip locked");
  });
});

/** Fake db for planMeeting: the marker insert answers a new id (or nothing when `taken`), email enqueue + bells recorded. */
function fakePlanDb(taken: string[] = []) {
  const markers: unknown[][] = [];
  const emails: unknown[][] = [];
  const bells: { recipients: string[]; title: string; email: string | null }[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql === INSERT_REMINDER_SQL) {
        if (taken.includes(`${params[3]}:${params[4]}`)) return { rows: [], rowCount: 0 };
        markers.push(params);
        return { rows: [{ id: `r${markers.length}` }], rowCount: 1 };
      }
      if (sql.includes("as admin_ids")) return { rows: [{ owner_id: "owner-1", owner_name: "Ravi", owner_active: true, owner_member: true, admin_ids: ["admin-1"] }] };
      if (sql.includes("from public.leads l") && sql.includes("join public.workspaces w")) return { rows: [{ owner_name: "Ravi Kumar", company_name: "MOTM" }] };
      if (sql.includes("insert into public.email_outbound_messages")) {
        emails.push(params);
        return { rows: [{ id: "e1" }], rowCount: 1 };
      }
      if (sql.includes("insert into public.notifications")) {
        bells.push({ recipients: params[1] as string[], title: params[2] as string, email: params[7] as string | null });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
  } as unknown as Queryable;
  return { db, markers, emails, bells };
}

describe("LL-2 planMeeting", () => {
  it("queues the fixed-text email (service source, no AI) and the WhatsApp row", async () => {
    const f = fakePlanDb();
    const done = await planMeeting(f.db, meeting(), ist("2026-11-17T15:00"));
    expect(done).toEqual([{ kind: "24h", channel: "email" }, { kind: "24h", channel: "whatsapp" }]);
    // email: source meeting_reminder, the reminder's id as source id, the lead's address.
    expect(f.emails[0]!.slice(1, 5)).toEqual(["meeting_reminder", "r1", "lead-1", "asha@example.com"]);
    expect(f.emails[0]![7]).toBe("Reminder: our meeting on Wednesday, 18 November at 3:00 pm IST");
    // WhatsApp: queued with its fixed text.
    expect(f.markers[1]!.slice(3, 8)).toEqual(["24h", "whatsapp", MEETING, "queued", "Hi Asha, a quick reminder of our meeting tomorrow, Wednesday, 18 November at 3:00 pm IST.\nJoin here: https://meet.google.com/abc-defg-hij\n— Ravi Kumar"]);
  });

  it("the rep: a bell + email (urgent) to the responsible person, once", async () => {
    const f = fakePlanDb(["1h:email", "1h:whatsapp"]);
    await planMeeting(f.db, meeting({ done: ["24h:email", "24h:whatsapp"] }), ist("2026-11-18T14:00"));
    expect(f.bells).toEqual([{ recipients: ["owner-1"], title: "Meeting in 1 hour: Asha Rao at 3:00 pm IST", email: "pending" }]);
    const again = fakePlanDb(["1h:email", "1h:whatsapp", "rep_1h:staff"]);
    expect(await planMeeting(again.db, meeting(), ist("2026-11-18T14:00"))).toEqual([]);
    expect(again.bells).toEqual([]);
  });
});

describe("LL-2 service messages", () => {
  it("a WhatsApp reminder follows the `meeting` rules: no send window, but caps / pause still apply", () => {
    expect(safetySourceOf({ type: "meeting_reminder", id: "r1" })).toBe("meeting");
    const base = {
      source: safetySourceOf({ type: "meeting_reminder", id: "r1" }),
      now: ist("2026-11-15T21:00"), // Sunday night: outside the window
      window: DEFAULT_SEND_WINDOW,
      dailyCap: 100,
      warmupDay: null,
      sentToday: 0,
      maxNewChatsPerDay: 20,
      newChatsToday: 0,
      isFirstMessage: false,
      text: "Hi",
      paused: false,
      nextSendAt: null,
      random: () => 0,
    };
    expect("send" in decideSend(base)).toBe(true);
    expect("defer" in decideSend({ ...base, sentToday: 100 })).toBe(true);
    expect("defer" in decideSend({ ...base, paused: true })).toBe(true);
  });

  it("an email reminder is not automated (no window) but obeys the mailbox caps", () => {
    expect(isAutomatedEmail("meeting_reminder")).toBe(false);
    const input = {
      source: "meeting_reminder" as const,
      now: ist("2026-11-15T21:00"),
      window: DEFAULT_SEND_WINDOW,
      dailyCap: 100,
      hourlyCap: 20,
      warmupDay: null,
      alreadyWarmed: true,
      sentToday: 0,
      sentThisHour: 0,
      paused: false,
      nextSendAt: null,
      recipientProblem: null,
      random: () => 0,
    };
    expect("send" in decideEmailSend(input)).toBe(true);
    expect("defer" in decideEmailSend({ ...input, sentToday: 100 })).toBe(true);
  });
});

describe("LL-2 reschedule", () => {
  it("only a changed time counts", () => {
    const current = { scheduled_at: MEETING };
    expect(meetingTimeChanged(current, { at: "2026-11-19T09:30:00.000Z" })).toBe(true);
    expect(meetingTimeChanged(current, { at: MEETING.toISOString() })).toBe(false);
    expect(meetingTimeChanged(current, {})).toBe(false);
  });

  it("resets the markers: queued reminders (and their queued emails) cancelled, planning from now", async () => {
    const seen: string[] = [];
    const db = { query: async (sql: string) => (seen.push(sql), { rows: [], rowCount: 0 }) } as unknown as Queryable;
    await resetMeetingReminders(db, "m1");
    expect(seen).toEqual([RESET_REMINDERS_SQL, RESET_FROM_SQL]);
    expect(RESET_REMINDERS_SQL).toContain("status = 'cancelled'");
    expect(RESET_REMINDERS_SQL).toContain("e.source = 'meeting_reminder'");
    expect(RESET_FROM_SQL).toContain("reminders_from = now()");
  });
});
