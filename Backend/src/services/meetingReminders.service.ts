/**
 * LL-2 rule 4: meeting reminders. Every SQL query of the feature lives here (INT-1 verifies them); the schedule and
 * the fixed texts are pure in domain/reminders.ts.
 * - To the lead: 24 h and 1 h before a `scheduled` meeting, by email (usable address) and WhatsApp (usable phone on the
 *   lead's sticky number), workspace setting `meeting_reminders_enabled` (default on). Service messages: queued like
 *   the meeting confirmation (email source `meeting_reminder`, WhatsApp source `meeting_reminder` = the `meeting` safety
 *   rules: no send window, but spacing / caps / warm-up / pause / opt-out / DNC); never AI touches, never a wake-up,
 *   no message fact.
 * - To the rep: 1 h before, a bell + email (rule 3) to the meeting's owner (rule 1: else the admins).
 * - Reschedule: queued reminders of the old time are cancelled, `reminders_from` moves to now, and an "Updated: …"
 *   confirmation goes out (meetingScheduledNotification.service.ts `notifyMeetingUpdated`).
 * One `meeting_reminders` row per meeting × kind × channel × meeting time is the once-only marker.
 */
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { reminderAction, reminderEmail, reminderSendAt, reminderWhatsApp, repReminderTitle, textToHtml, type LeadReminderKind } from "../domain/reminders.js";
import { HOUR_MS } from "../domain/workingTime.js";
import { enqueueEmail } from "./emailOutbound.service.js";
import { fairPickSql } from "./fairPick.js";
import { loadResponsible, notifyUsers } from "./nextAction.service.js";
import { sendWhatsApp } from "../providers/whatsapp.provider.js";
import { ProviderDeferredError } from "../providers/provider-errors.js";
import { addTimelineEvent, SYSTEM_ACTOR } from "./timeline.service.js";
import { AUTOMATED_SQL } from "./leadAutomation.service.js";

/** P7: meetings looked at per tick (soonest first, round-robin across workspaces). */
const TICK_LIMIT = 200;
/** A 24 h reminder moved to the last working slot can be up to ~2.5 days early (Saturday 18:45 for a Monday morning). */
const LOOK_AHEAD = "3 days";

export const EMAIL_UNUSABLE = ["invalid", "permanent_bounce", "unsubscribed"];
export const WHATSAPP_UNUSABLE = ["opted_out", "invalid"];

/** $1 now, $2 workspace ids (null = all), $3 tick limit. Scheduled meetings starting within LOOK_AHEAD, live automated (REL-1) leads. */
export const PLAN_CANDIDATES_SQL = `select m.id, m.workspace_id, m.lead_id, m.owner_id, m.title, m.scheduled_at, m.reminders_from,
       coalesce(m.meet_link, m.meeting_url) as link, coalesce(op.full_name, m.owner_name) as rep_name,
       l.first_name, nullif(trim(concat_ws(' ', l.first_name, l.last_name)), '') as lead_name,
       l.email, l.phone_e164, l.whatsapp_number_id, ce.status as email_status, cw.status as whatsapp_status,
       coalesce(s.meeting_reminders_enabled, true) as lead_reminders_enabled,
       array(select r.kind || ':' || r.channel from public.meeting_reminders r where r.meeting_id = m.id and r.meeting_at = m.scheduled_at) as done
  from public.meetings m
  join public.leads l on l.id = m.lead_id and l.workspace_id = m.workspace_id
   and l.lifecycle_state not in ('do_not_contact', 'merged') and l.merged_into_lead_id is null
  left join public.agent_settings s on s.workspace_id = m.workspace_id
  left join public.profiles op on op.id = m.owner_id
  left join public.lead_contact_channels ce on ce.lead_id = l.id and ce.channel = 'email'
  left join public.lead_contact_channels cw on cw.lead_id = l.id and cw.channel = 'whatsapp'
 where m.id in (${fairPickSql({
   from: "public.meetings x",
   where: `x.status = 'scheduled' and x.scheduled_at > $1::timestamptz and x.scheduled_at <= $1::timestamptz + interval '${LOOK_AHEAD}'
     and ($2::uuid[] is null or x.workspace_id = any($2::uuid[]))
     and exists (select 1 from public.leads al where al.id = x.lead_id and ${AUTOMATED_SQL("al")})`,
   order: "x.scheduled_at",
   limit: "$3",
 })})
 order by m.scheduled_at`;

/** The once-only marker: a second planner for the same meeting × kind × channel × time gets no row. */
export const INSERT_REMINDER_SQL = `insert into public.meeting_reminders (workspace_id, meeting_id, lead_id, kind, channel, meeting_at, status, body, next_attempt_at, sent_at)
  values ($1, $2, $3, $4, $5, $6, $7, $8, now(), case when $7 = 'sent' then now() end)
  on conflict (meeting_id, kind, channel, meeting_at) do nothing
  returning id`;

/** Reschedule: queued reminders of the meeting (old time) are cancelled; their queued emails too. $1 meeting id. */
export const RESET_REMINDERS_SQL = `with cancelled as (
    update public.meeting_reminders set status = 'cancelled', error = 'Meeting time changed'
     where meeting_id = $1 and status in ('queued', 'sending') returning id)
  update public.email_outbound_messages e set status = 'cancelled', last_error = 'Meeting time changed'
    from cancelled c where e.source = 'meeting_reminder' and e.source_id = c.id and e.status = 'queued'`;
export const RESET_FROM_SQL = `update public.meetings set reminders_from = now() where id = $1`;

/** SKIP LOCKED claim of queued WhatsApp reminders (15-minute reclaim), round-robin across workspaces. $1 limit. */
export const CLAIM_WHATSAPP_SQL = `update public.meeting_reminders
    set status = 'sending', next_attempt_at = now() + interval '15 minutes'
  where id in (
    select id from public.meeting_reminders
     where id in (${fairPickSql({
       from: "public.meeting_reminders x",
       where: "x.channel = 'whatsapp' and x.status in ('queued', 'sending') and x.next_attempt_at <= now()",
       order: "x.next_attempt_at",
       limit: "$1",
     })})
       and channel = 'whatsapp' and status in ('queued', 'sending') and next_attempt_at <= now()
     for update skip locked)
  returning *`;

export interface PlanRow {
  id: string;
  workspace_id: string;
  lead_id: string;
  owner_id: string | null;
  title: string;
  scheduled_at: Date;
  reminders_from: Date;
  link: string | null;
  rep_name: string | null;
  first_name: string | null;
  lead_name: string | null;
  email: string | null;
  phone_e164: string | null;
  whatsapp_number_id: string | null;
  email_status: string | null;
  whatsapp_status: string | null;
  lead_reminders_enabled: boolean;
  done: string[] | null;
}

export type PlannedReminder = { kind: LeadReminderKind | "rep_1h"; channel: "email" | "whatsapp" | "staff" };

/** Usable channels for a lead reminder: email (address, not invalid / bounced / unsubscribed); WhatsApp (phone on the sticky number, not opted out / invalid). */
export function usableChannels(m: Pick<PlanRow, "email" | "email_status" | "phone_e164" | "whatsapp_number_id" | "whatsapp_status">): ("email" | "whatsapp")[] {
  return [
    ...(m.email && !EMAIL_UNUSABLE.includes(m.email_status ?? "") ? (["email"] as const) : []),
    ...(m.phone_e164 && m.whatsapp_number_id && !WHATSAPP_UNUSABLE.includes(m.whatsapp_status ?? "") ? (["whatsapp"] as const) : []),
  ];
}

/** Pure: what is due now for one meeting (rows not yet in `done`). Skipped reminders are simply never sent. */
export function dueReminders(m: PlanRow, now: Date): PlannedReminder[] {
  const done = new Set(m.done ?? []);
  const out: PlannedReminder[] = [];
  if (m.lead_reminders_enabled) {
    for (const kind of ["24h", "1h"] as const) {
      if (reminderAction(kind, m.scheduled_at, m.reminders_from, now) !== "send") continue;
      for (const channel of usableChannels(m)) if (!done.has(`${kind}:${channel}`)) out.push({ kind, channel });
    }
  }
  // The rep: 1 h before (not when booked less than 1 h ahead), whatever the workspace setting.
  if (!done.has("rep_1h:staff") && reminderAction("1h", m.scheduled_at, m.reminders_from, now) === "send") out.push({ kind: "rep_1h", channel: "staff" });
  return out;
}

/** One meeting in its own transaction: insert each due marker (once) and queue / notify. Returns what was done. */
export async function planMeeting(db: Queryable, m: PlanRow, now: Date): Promise<PlannedReminder[]> {
  const done: PlannedReminder[] = [];
  for (const r of dueReminders(m, now)) {
    if (r.kind === "rep_1h") {
      const inserted = await db.query<{ id: string }>(INSERT_REMINDER_SQL, [m.workspace_id, m.id, m.lead_id, "rep_1h", "staff", m.scheduled_at, "sent", null]);
      if (!inserted.rows[0]) continue;
      const responsible = await loadResponsible(db, m.workspace_id, m.lead_id, m.owner_id);
      await notifyUsers(db, m.workspace_id, responsible.notify, m.lead_id, {
        title: repReminderTitle(m.lead_name ?? "a contact", m.scheduled_at),
        detail: [m.title, m.link].filter(Boolean).join("\n"),
        kind: "info",
        email: true,
      });
      done.push(r);
      continue;
    }
    const sendAt = reminderSendAt(r.kind, m.scheduled_at, m.reminders_from) ?? now;
    const text = { kind: r.kind, firstName: m.first_name, meetingAt: m.scheduled_at, sendAt, link: m.link, repName: m.rep_name };
    if (r.channel === "email") {
      const inserted = await db.query<{ id: string }>(INSERT_REMINDER_SQL, [m.workspace_id, m.id, m.lead_id, r.kind, "email", m.scheduled_at, "queued", null]);
      if (!inserted.rows[0]) continue;
      const mail = reminderEmail(text);
      await enqueueEmail(db, { workspaceId: m.workspace_id, source: "meeting_reminder", sourceId: inserted.rows[0].id, leadId: m.lead_id, to: m.email!, subject: mail.subject, html: textToHtml(mail.text) });
    } else {
      const inserted = await db.query<{ id: string }>(INSERT_REMINDER_SQL, [m.workspace_id, m.id, m.lead_id, r.kind, "whatsapp", m.scheduled_at, "queued", reminderWhatsApp(text)]);
      if (!inserted.rows[0]) continue;
    }
    done.push(r);
  }
  return done;
}

/** Worker step (every tick): plan due reminders; each meeting in its own short transaction. */
export async function runMeetingReminders(opts: { now?: Date; workspaceIds?: string[] } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const rows = (await pool.query<PlanRow>(PLAN_CANDIDATES_SQL, [now, opts.workspaceIds ?? null, TICK_LIMIT])).rows;
  let count = 0;
  for (const m of rows) {
    if (!dueReminders(m, now).length) continue;
    count += (await withTransaction((db) => planMeeting(db, m, now))).length;
  }
  return count;
}

/** Reschedule (meeting time changed): cancel what was queued for the old time and plan from now (rule 4). */
export async function resetMeetingReminders(db: Queryable, meetingId: string): Promise<void> {
  await db.query(RESET_REMINDERS_SQL, [meetingId]);
  await db.query(RESET_FROM_SQL, [meetingId]);
}

/** "Updated" confirmation rows (kind `updated`): the marker per channel + the email / WhatsApp body. Returns the row id or null (already queued). */
export async function insertUpdatedReminder(
  db: Queryable,
  m: { workspace_id: string; id: string; lead_id: string; scheduled_at: Date },
  channel: "email" | "whatsapp",
  body: string | null,
): Promise<string | null> {
  return (await db.query<{ id: string }>(INSERT_REMINDER_SQL, [m.workspace_id, m.id, m.lead_id, "updated", channel, m.scheduled_at, "queued", body])).rows[0]?.id ?? null;
}

// --- WhatsApp queue ------------------------------------------------------------------------------

export interface ReminderRow {
  id: string;
  workspace_id: string;
  meeting_id: string;
  lead_id: string;
  kind: string;
  meeting_at: Date;
  body: string | null;
}

export async function claimReminderWhatsappSends(db: Queryable, limit: number): Promise<ReminderRow[]> {
  return (await db.query<ReminderRow>(CLAIM_WHATSAPP_SQL, [limit])).rows;
}

/** Sends one claimed reminder. A deferral waits (never an attempt) until it is pointless: the next reminder's time / the start. */
export async function processReminderWhatsappSend(row: ReminderRow, deps: { send?: typeof sendWhatsApp; dryRun?: boolean; now?: () => Date } = {}): Promise<string> {
  const set = (status: string, error: string | null, extra = "") =>
    pool.query(`update public.meeting_reminders set status = $2, error = $3${extra} where id = $1`, [row.id, status, error]);
  try {
    const phone = (await pool.query<{ phone_e164: string | null }>(`select phone_e164 from public.leads where id = $1`, [row.lead_id])).rows[0]?.phone_e164;
    if (!phone || !row.body) {
      await set("failed", "The contact no longer has a WhatsApp-capable phone number.");
      return "failed";
    }
    if (deps.dryRun) {
      console.log(`[worker] DRY RUN — would send meeting reminder ${row.id} (${row.kind}) on WhatsApp.`);
      await set("sent", "dry run", ", sent_at = now()");
      return "dry_run";
    }
    await (deps.send ?? sendWhatsApp)(row.workspace_id, { source: { type: "meeting_reminder", id: row.id }, to: phone, body: row.body });
    await set("sent", null, ", sent_at = now()");
    await recordReminderSent(pool, row.id, "whatsapp");
    return "sent";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ProviderDeferredError) {
      const now = deps.now?.() ?? new Date();
      const pointlessAt = row.kind === "24h" ? row.meeting_at.getTime() - HOUR_MS : row.meeting_at.getTime();
      if (now.getTime() + err.retryAfterMs >= pointlessAt) {
        await set("skipped", `Not sent in time: ${message}`);
        return "skipped";
      }
      await pool.query(`update public.meeting_reminders set status = 'queued', next_attempt_at = now() + ($2 || ' milliseconds')::interval, error = $3 where id = $1`, [
        row.id,
        String(err.retryAfterMs),
        message,
      ]);
      return "deferred";
    }
    // A permanent problem (not eligible any more, not on WhatsApp, a link rule) or an unexpected error: no retry.
    await set("failed", message);
    return "failed";
  }
}

const REMINDER_TITLE: Record<string, string> = {
  "24h": "Meeting reminder sent (24 h before)",
  "1h": "Meeting reminder sent (1 h before)",
  updated: "Meeting update sent",
};

/**
 * UX-3: a reminder / "Updated" message that really went to the lead (never a dry run, never the rep's own reminder) gets
 * one timeline row under Meetings & proposals. Its own event kind `meeting_reminder` keeps it out of the AI's context
 * timeline (agentContext TIMELINE_KINDS): a service message is never a touch.
 */
export async function recordReminderSent(db: Queryable, reminderId: string, channel: "email" | "whatsapp"): Promise<void> {
  const r = (await db.query<{ lead_id: string; meeting_id: string; kind: string }>(`select lead_id, meeting_id, kind from public.meeting_reminders where id = $1`, [reminderId]))
    .rows[0];
  const title = r && REMINDER_TITLE[r.kind];
  if (!r || !title) return;
  await addTimelineEvent(db, {
    leadId: r.lead_id,
    kind: "meeting_reminder",
    title,
    detail: channel === "email" ? "By email" : "On WhatsApp",
    ...SYSTEM_ACTOR,
    relatedMeetingId: r.meeting_id,
  });
}
