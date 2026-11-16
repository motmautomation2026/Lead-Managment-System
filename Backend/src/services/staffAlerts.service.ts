/**
 * LL-2 rule 3: staff email alerts (urgent bells, batched per person per tick) and the 09:00 IST morning digest.
 * Every SQL query of the feature lives here (INT-1 verifies them); the texts are pure in domain/staffEmail.ts.
 * A SEPARATE path from lead email: sent with the workspace's connected mailbox straight through its SMTP transport,
 * never a row in email_outbound_messages, so never in lead email limits / stats / message_facts / timelines; no
 * List-Unsubscribe, no pixel. Respects WORKER_DRY_RUN. No mailbox (or paused) → bell only + one admin warning
 * (system_health_alerts `staff_email_no_mailbox`). Recipient = the user's login email. Never WhatsApp.
 */
import { randomUUID } from "node:crypto";
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { appBaseUrl } from "../env.js";
import { REPLY_TASK_TITLES } from "../agent/replyClassification.js";
import { DECIDE_NEXT_STEP_TITLE } from "../domain/nextAction.js";
import { domainOf, messageIdFor } from "../domain/emailSafety.js";
import { alertEmail, digestEmail, digestWindowOpen, type AlertItem, type DigestCounts } from "../domain/staffEmail.js";
import { istDate } from "../domain/workingTime.js";
import { defaultTransportCache, type EmailTransport } from "../providers/email.provider.js";
import { loadEmailConnection, mailboxOf, type Mailbox } from "./emailConnection.service.js";
import { fairPickSql } from "./fairPick.js";
import { WORKSPACE_ADMIN_IDS_SQL } from "./profiles.service.js";

/** P7: alerts claimed per tick (round-robin across workspaces); digests per tick. */
const ALERT_TICK_LIMIT = 500;
const DIGEST_TICK_LIMIT = 50;
/** An alert still pending after this long (worker down) is skipped: stale news by email helps nobody. */
const STALE_MS = 24 * 3_600_000;

/** Claim (inside a transaction): pending → sending, with the recipient's login email and toggle. $1 limit. */
export const CLAIM_ALERTS_SQL = `with picked as (
    select n.id from public.notifications n
     where n.id in (${fairPickSql({ from: "public.notifications x", where: "x.email_status = 'pending' and x.workspace_id is not null", order: "x.created_at", limit: "$1" })})
       and n.email_status = 'pending'
     for update skip locked)
  update public.notifications n set email_status = 'sending'
    from picked, public.profiles p
   where n.id = picked.id and p.id = n.recipient_id
  returning n.id, n.workspace_id, n.recipient_id, n.title, n.detail, n.href, n.created_at,
            p.email, p.full_name, p.is_active and p.email_alerts_enabled as wants_email`;

/** $1 ids, $2 status. */
export const MARK_ALERTS_SQL = `update public.notifications set email_status = $2 where id = any($1::uuid[]) and email_status = 'sending'`;

/** One warning per workspace, ever (the first time a staff email had no mailbox). $1 workspace, $2 now. */
export const WARN_NO_MAILBOX_SQL = `with fresh as (
    insert into public.system_health_alerts (workspace_id, problem, alerted_on)
    select $1, 'staff_email_no_mailbox', ($2::timestamptz at time zone 'Asia/Kolkata')::date
     where not exists (select 1 from public.system_health_alerts where workspace_id = $1 and problem = 'staff_email_no_mailbox')
    on conflict do nothing returning 1)
  insert into public.notifications (workspace_id, recipient_id, title, detail, kind, href)
  select $1, a.user_id, 'Staff email alerts are off: no mailbox', $3, 'warning', '/settings/email'
    from (${WORKSPACE_ADMIN_IDS_SQL}) a where exists (select 1 from fresh)`;
const NO_MAILBOX_DETAIL =
  "Urgent alerts and the morning digest can't be emailed because no email mailbox is connected (or sending is paused). They stay in the bell. An admin can connect one in Settings → Email.";

/** Lead filter for the digest counts: active / long-term-nurture, not merged. */
const LIVE_LEAD = `join public.leads l on l.id = t.lead_id and l.workspace_id = t.workspace_id and l.lifecycle_state in ('active', 'long_term_nurture') and l.merged_into_lead_id is null`;
const OPEN_TASKS = `public.tasks t ${LIVE_LEAD} where t.workspace_id = m.workspace_id and t.owner_id = m.user_id and t.status = 'open'`;

/**
 * Members due a digest today: active, digest on, not sent today. $1 now, $2 end of the IST day, $3 start of the IST
 * day, $4 the IST date, $5 reply task titles, $6 "Decide the next step", $7 workspace ids (null = all), $8 limit.
 */
export const DIGEST_CANDIDATES_SQL = `select m.workspace_id, m.user_id, p.email, p.full_name, w.name as workspace_name,
       (select count(*)::int from ${OPEN_TASKS} and t.task_type = 'call' and t.due_at < $2) as calls,
       (select count(*)::int from ${OPEN_TASKS} and t.origin = 'agent' and t.title = any($5::text[])) as replies,
       (select count(*)::int from public.meetings mt where mt.workspace_id = m.workspace_id and mt.owner_id = m.user_id
                and mt.status = 'scheduled' and mt.scheduled_at >= $3 and mt.scheduled_at < $2) as meetings,
       (select count(*)::int from ${OPEN_TASKS} and t.title = $6) as next_steps,
       (select count(*)::int from ${OPEN_TASKS} and t.due_at < $1) as overdue
  from public.workspace_members m
  join public.profiles p on p.id = m.user_id and p.is_active and p.email_digest_enabled
  join public.workspaces w on w.id = m.workspace_id and w.is_active
 where (m.digest_sent_on is null or m.digest_sent_on < $4::date)
   and ($7::uuid[] is null or m.workspace_id = any($7::uuid[]))
 order by m.workspace_id, m.user_id
 limit $8`;

/** Once per member per IST day. $1 workspace, $2 user, $3 IST date. */
export const CLAIM_DIGEST_SQL = `update public.workspace_members set digest_sent_on = $3::date
  where workspace_id = $1 and user_id = $2 and (digest_sent_on is null or digest_sent_on < $3::date) returning user_id`;

export interface StaffEmailDeps {
  now?: Date;
  dryRun?: boolean;
  baseUrl?: string;
  /** The workspace's mailbox (null = none / paused). Default: the saved SMTP mailbox. */
  mailbox?: (workspaceId: string) => Promise<Mailbox | null>;
  transport?: (workspaceId: string, box: Mailbox) => EmailTransport;
  db?: Queryable;
}

async function savedMailbox(workspaceId: string): Promise<Mailbox | null> {
  try {
    const { row, secrets } = await loadEmailConnection(pool, workspaceId);
    const box = mailboxOf(row, secrets);
    return box && box.enabled ? box : null;
  } catch {
    return null;
  }
}

type SendResult = "sent" | "skipped" | "failed";

/** One staff email through the workspace's SMTP (or a dry-run log). No transaction is held across it. */
async function sendStaffEmail(workspaceId: string, to: string, mail: { subject: string; text: string; html: string }, deps: StaffEmailDeps, db: Queryable): Promise<SendResult> {
  const box = await (deps.mailbox ?? savedMailbox)(workspaceId);
  if (!box) {
    await db.query(WARN_NO_MAILBOX_SQL, [workspaceId, deps.now ?? new Date(), NO_MAILBOX_DETAIL]);
    return "skipped";
  }
  if (deps.dryRun) {
    console.log(`[staff-email] DRY RUN — would email a staff member: ${mail.subject}`);
    return "skipped";
  }
  try {
    const transport = deps.transport ? deps.transport(workspaceId, box) : defaultTransportCache.get(workspaceId, box.transportKey, box.smtp);
    await transport.sendMail({
      from: { name: box.fromName, address: box.fromAddress },
      to,
      replyTo: box.replyTo,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      messageId: messageIdFor(domainOf(box.fromAddress), randomUUID()),
      date: deps.now ?? new Date(),
      headers: {},
      attachments: [],
    });
    return "sent";
  } catch (err) {
    // Codes only: an SMTP message can quote addresses.
    console.error(`[staff-email] send failed: ${(err as { code?: string })?.code ?? (err as Error)?.name ?? "error"}`);
    return "failed";
  }
}

interface ClaimedAlert {
  id: string;
  workspace_id: string;
  recipient_id: string;
  title: string;
  detail: string | null;
  href: string | null;
  created_at: Date;
  email: string;
  full_name: string | null;
  wants_email: boolean;
}

/** Worker step (every tick): urgent alerts → one email per person per workspace. Returns emails sent. */
export async function runStaffAlertEmails(deps: StaffEmailDeps = {}): Promise<number> {
  const db = deps.db ?? pool;
  const now = deps.now ?? new Date();
  const claimed = deps.db
    ? (await db.query<ClaimedAlert>(CLAIM_ALERTS_SQL, [ALERT_TICK_LIMIT])).rows
    : await withTransaction(async (tx) => (await tx.query<ClaimedAlert>(CLAIM_ALERTS_SQL, [ALERT_TICK_LIMIT])).rows);
  const groups = new Map<string, ClaimedAlert[]>();
  for (const a of claimed) groups.set(`${a.workspace_id}:${a.recipient_id}`, [...(groups.get(`${a.workspace_id}:${a.recipient_id}`) ?? []), a]);
  let sent = 0;
  for (const alerts of groups.values()) {
    const first = alerts[0]!;
    const fresh = alerts.filter((a) => now.getTime() - a.created_at.getTime() <= STALE_MS);
    const stale = alerts.filter((a) => !fresh.includes(a)).map((a) => a.id);
    if (stale.length) await db.query(MARK_ALERTS_SQL, [stale, "skipped"]);
    if (!fresh.length) continue;
    const ids = fresh.map((a) => a.id);
    if (!first.wants_email || !first.email) {
      await db.query(MARK_ALERTS_SQL, [ids, "skipped"]);
      continue;
    }
    const items: AlertItem[] = fresh.map((a) => ({ title: a.title, detail: a.detail, href: a.href }));
    const result = await sendStaffEmail(first.workspace_id, first.email, alertEmail(first.full_name, items, deps.baseUrl ?? appBaseUrl), deps, db);
    await db.query(MARK_ALERTS_SQL, [ids, result]);
    if (result === "sent") sent += 1;
  }
  return sent;
}

interface DigestRow extends Omit<DigestCounts, "nextSteps"> {
  workspace_id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  workspace_name: string;
  next_steps: number;
}

const IST_OFFSET_MS = 330 * 60_000;
const istDayBounds = (now: Date) => {
  const start = Math.floor((now.getTime() + IST_OFFSET_MS) / 86_400_000) * 86_400_000 - IST_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + 86_400_000) };
};

/** Worker step: the morning digest 09:00–12:00 IST Mon–Sat, once per member per IST day; empty ones skipped. */
export async function runMorningDigest(deps: StaffEmailDeps & { workspaceIds?: string[] } = {}): Promise<number> {
  const now = deps.now ?? new Date();
  if (!digestWindowOpen(now)) return 0;
  const db = deps.db ?? pool;
  const { start, end } = istDayBounds(now);
  const today = istDate(now);
  const rows = (
    await db.query<DigestRow>(DIGEST_CANDIDATES_SQL, [now, end, start, today, REPLY_TASK_TITLES, DECIDE_NEXT_STEP_TITLE, deps.workspaceIds ?? null, DIGEST_TICK_LIMIT])
  ).rows;
  let sent = 0;
  for (const r of rows) {
    // The claim is the once-only marker (also for an empty digest: nothing to say today).
    if (!(await db.query(CLAIM_DIGEST_SQL, [r.workspace_id, r.user_id, today])).rowCount) continue;
    const mail = digestEmail(r.full_name, r.workspace_name, { calls: r.calls, replies: r.replies, meetings: r.meetings, nextSteps: r.next_steps, overdue: r.overdue }, deps.baseUrl ?? appBaseUrl);
    if (!mail || !r.email) continue;
    if ((await sendStaffEmail(r.workspace_id, r.email, mail, deps, db)) === "sent") sent += 1;
  }
  return sent;
}
