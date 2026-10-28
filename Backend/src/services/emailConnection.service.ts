import type { Actor } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { ValidationError } from "../errors.js";
import { decryptJson, encryptJson, type EncryptedValue } from "../security/encryption.js";
import { recordAdminAudit } from "./admin-audit.service.js";
import { notifyAdmins } from "./whatsappSafety.service.js";
import { emailWarmupCap, warmupDayFor, type SendWindow } from "../domain/emailSafety.js";
import type { MailSecurity, SmtpConfig } from "../providers/email.provider.js";

/**
 * E1b: the workspace's SMTP + IMAP mailbox (the `integration_connections` 'email' row),
 * its safety settings, auto-pause / resume and the monitoring numbers. Only `smtp`
 * counts as configured; a row still on `resend` (or none) is "not set up".
 */

interface EmailSettingsJson {
  senderName?: string;
  senderAddress?: string;
  replyTo?: string | null;
  smtpHost?: string;
  smtpPort?: number;
  /** "tls" = rows saved before E1b (implicit TLS). */
  smtpSecurity?: MailSecurity | "tls";
  imapHost?: string;
  imapPort?: number;
  imapSecurity?: MailSecurity;
  imapSameLogin?: boolean;
  imapFolder?: string;
}

interface EmailSecrets {
  smtpUsername?: string;
  smtpPassword?: string;
  imapUsername?: string;
  imapPassword?: string;
}

export interface EmailRow {
  provider: "resend" | "smtp" | null;
  enabled: boolean;
  settings: EmailSettingsJson;
  secret_ciphertext: Buffer | null;
  secret_iv: Buffer | null;
  secret_tag: Buffer | null;
  key_version: number;
  updated_at: Date;
  configured_at: Date | null;
  already_warmed: boolean;
  daily_cap: number;
  hourly_cap: number;
  min_delay_seconds: number;
  max_delay_seconds: number;
  send_window_days: number[];
  send_window_start: string;
  send_window_end: string;
  next_send_at: Date | null;
  paused_reason: string | null;
  paused_at: Date | null;
  resumed_at: Date | null;
}

export async function loadEmailConnection(db: Queryable, workspaceId: string): Promise<{ row: EmailRow; secrets: EmailSecrets }> {
  const result = await db.query<EmailRow>(`select * from public.integration_connections where workspace_id = $1 and id = 'email'`, [workspaceId]);
  const row = result.rows[0];
  if (!row) throw new ValidationError("This workspace has no email connection row.");
  const encrypted: EncryptedValue | null =
    row.secret_ciphertext && row.secret_iv && row.secret_tag
      ? { ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag, keyVersion: row.key_version }
      : null;
  // AAD is deliberately a fixed string, not workspace-namespaced (see baileys-auth.store.ts):
  // existing secrets were encrypted under it. Row isolation is the `where workspace_id` above.
  return { row, secrets: encrypted ? decryptJson<EmailSecrets>(encrypted, "integration:email") : {} };
}

const smtpSecurityOf = (s: EmailSettingsJson): MailSecurity => (s.smtpSecurity === "starttls" ? "starttls" : "ssl");

/** Everything the sender needs, or null when email is not set up (no SMTP saved). */
export interface Mailbox {
  smtp: SmtpConfig;
  /** Changes when the SMTP settings or secrets are saved: rebuild the pooled transport. */
  transportKey: string;
  fromAddress: string;
  fromName: string;
  replyTo: string;
  enabled: boolean;
  window: SendWindow;
  dailyCap: number;
  hourlyCap: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  configuredAt: Date | null;
  alreadyWarmed: boolean;
  nextSendAt: Date | null;
  resumedAt: Date | null;
}

export function mailboxOf(row: EmailRow, secrets: EmailSecrets): Mailbox | null {
  const s = row.settings;
  if (row.provider !== "smtp" || !s.smtpHost || !s.smtpPort || !s.senderAddress || !secrets.smtpUsername || !secrets.smtpPassword) return null;
  const smtp: SmtpConfig = { host: s.smtpHost, port: s.smtpPort, security: smtpSecurityOf(s), username: secrets.smtpUsername, password: secrets.smtpPassword };
  return {
    smtp,
    transportKey: [smtp.host, smtp.port, smtp.security, row.secret_iv?.toString("hex")].join("|"),
    fromAddress: s.senderAddress,
    fromName: s.senderName || s.senderAddress,
    replyTo: s.replyTo || s.senderAddress,
    enabled: row.enabled,
    window: { days: row.send_window_days, start: row.send_window_start, end: row.send_window_end },
    dailyCap: row.daily_cap,
    hourlyCap: row.hourly_cap,
    minDelaySeconds: row.min_delay_seconds,
    maxDelaySeconds: row.max_delay_seconds,
    configuredAt: row.configured_at,
    alreadyWarmed: row.already_warmed,
    nextSendAt: row.next_send_at,
    resumedAt: row.resumed_at,
  };
}

/** The IMAP login (same as SMTP's when `imapSameLogin`), or null when not saved. */
export function imapOf(row: EmailRow, secrets: EmailSecrets) {
  const s = row.settings;
  const username = s.imapSameLogin ? secrets.smtpUsername : secrets.imapUsername;
  const password = s.imapSameLogin ? secrets.smtpPassword : secrets.imapPassword;
  if (row.provider !== "smtp" || !s.imapHost || !s.imapPort || !username || !password) return null;
  return { host: s.imapHost, port: s.imapPort, security: s.imapSecurity ?? "ssl", username, password, folder: s.imapFolder || "INBOX" };
}

// ---------------------------------------------------------------------------
// Events, stats, pause

export type EmailEventKind = "send_failed" | "recipient_rejected" | "login_rejected" | "rate_limited" | "paused" | "resumed";

export async function recordEmailEvent(db: Queryable, workspaceId: string, kind: EmailEventKind, detail: string | null = null) {
  await db.query(`insert into public.email_safety_events (workspace_id, kind, detail) values ($1, $2, $3)`, [workspaceId, kind, detail]);
}

const IST_MIDNIGHT = `date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`;
const IST_HOUR = `date_trunc('hour', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`;
const SENT = `status = 'sent' and not dry_run`;

/** What one send needs. Signals count only after `resumedAt`, so a resume isn't undone by the signals that paused it. */
export async function loadEmailStats(db: Queryable, workspaceId: string, resumedAt: Date | null) {
  const result = await db.query<{ sent_today: number; sent_this_hour: number; sent_24h: number; rejected_24h: number; failures_30m: number }>(
    `with since as (
       select greatest(now() - interval '24 hours', coalesce($2::timestamptz, '-infinity')) as d1,
              greatest(now() - interval '30 minutes', coalesce($2::timestamptz, '-infinity')) as m30
     )
     select
       (select count(*)::int from public.email_outbound_messages where workspace_id = $1 and ${SENT} and sent_at >= ${IST_MIDNIGHT}) as sent_today,
       (select count(*)::int from public.email_outbound_messages where workspace_id = $1 and ${SENT} and sent_at >= ${IST_HOUR}) as sent_this_hour,
       (select count(*)::int from public.email_outbound_messages, since where workspace_id = $1 and ${SENT} and sent_at > since.d1) as sent_24h,
       (select count(*)::int from public.email_safety_events, since where workspace_id = $1 and kind = 'recipient_rejected' and created_at > since.d1) as rejected_24h,
       (select count(*)::int from public.email_safety_events, since where workspace_id = $1 and kind = 'send_failed' and created_at > since.m30) as failures_30m`,
    [workspaceId, resumedAt],
  );
  const r = result.rows[0]!;
  return { sentToday: r.sent_today, sentThisHour: r.sent_this_hour, sent24h: r.sent_24h, rejected24h: r.rejected_24h, failures30m: r.failures_30m };
}

/** Turns email off with a reason and notifies every active admin — once: only the call that flips `enabled` acts. */
export async function autoPauseEmail(db: Queryable, workspaceId: string, reason: string): Promise<boolean> {
  const paused = await db.query(
    `update public.integration_connections
        set enabled = false, paused_reason = $2, paused_at = now(), paused_by = null
      where workspace_id = $1 and id = 'email' and enabled
      returning workspace_id`,
    [workspaceId, reason],
  );
  if (!paused.rowCount) return false;
  await recordEmailEvent(db, workspaceId, "paused", reason);
  await notifyAdmins(db, workspaceId, "Email sending paused automatically", `${reason} An admin can resume it in Settings → Workspace → Email.`);
  return true;
}

/** Admin only (route guard): turns email back on; signals before now no longer count. */
async function resumeSending(db: Queryable, actor: Actor, workspaceId: string) {
  await db.query(
    `update public.integration_connections
        set enabled = true, paused_reason = null, paused_at = null, paused_by = null, resumed_at = now(), updated_by = $2
      where workspace_id = $1 and id = 'email'`,
    [workspaceId, actor.id],
  );
  await recordEmailEvent(db, workspaceId, "resumed", `Resumed by ${actor.fullName}`);
  await recordAdminAudit(db, actor, "connection.email.resumed", "integration_connection", `${workspaceId}:email`);
}

export async function resumeEmail(actor: Actor, workspaceId: string) {
  await withTransaction((db) => resumeSending(db, actor, workspaceId));
  return getEmailSettings(workspaceId);
}

// ---------------------------------------------------------------------------
// Settings (GET: every CRM user, no secrets; PUT: admin)

async function loadMonitoring(db: Queryable, workspaceId: string) {
  const [counts, events, days] = await Promise.all([
    db.query<{ failures_24h: number; rejected_24h: number; queued: number; paused_by_name: string | null }>(
      `select
         (select count(*)::int from public.email_safety_events where workspace_id = $1 and kind = 'send_failed' and created_at > now() - interval '24 hours') as failures_24h,
         (select count(*)::int from public.email_safety_events where workspace_id = $1 and kind = 'recipient_rejected' and created_at > now() - interval '24 hours') as rejected_24h,
         (select count(*)::int from public.email_outbound_messages where workspace_id = $1 and status in ('queued', 'sending')) as queued,
         (select p.full_name from public.integration_connections c join public.profiles p on p.id = c.paused_by where c.workspace_id = $1 and c.id = 'email') as paused_by_name`,
      [workspaceId],
    ),
    db.query<{ kind: EmailEventKind; detail: string | null; created_at: Date }>(
      `select kind, detail, created_at from public.email_safety_events where workspace_id = $1 order by created_at desc limit 20`,
      [workspaceId],
    ),
    db.query<{ date: string; sent: number; failed: number; rejected: number }>(
      `with days as (
         select d::date as d, d at time zone 'Asia/Kolkata' as from_at, (d + interval '1 day') at time zone 'Asia/Kolkata' as to_at
           from generate_series(date_trunc('day', now() at time zone 'Asia/Kolkata') - interval '13 days',
                                date_trunc('day', now() at time zone 'Asia/Kolkata'), interval '1 day') d
       )
       select d::text as date,
         (select count(*)::int from public.email_outbound_messages o
           where o.workspace_id = $1 and o.${SENT} and o.sent_at >= from_at and o.sent_at < to_at) as sent,
         (select count(*)::int from public.email_safety_events e
           where e.workspace_id = $1 and e.kind = 'send_failed' and e.created_at >= from_at and e.created_at < to_at) as failed,
         (select count(*)::int from public.email_safety_events e
           where e.workspace_id = $1 and e.kind = 'recipient_rejected' and e.created_at >= from_at and e.created_at < to_at) as rejected
       from days order by d desc`,
      [workspaceId],
    ),
  ]);
  const row = counts.rows[0]!;
  return {
    failures24h: row.failures_24h,
    rejections24h: row.rejected_24h,
    queuedCount: row.queued,
    pausedByName: row.paused_by_name,
    safetyEvents: events.rows.map((e) => ({ kind: e.kind, detail: e.detail, at: e.created_at.toISOString() })),
    daily: days.rows,
  };
}

export async function getEmailSettings(workspaceId: string) {
  const { row, secrets } = await loadEmailConnection(pool, workspaceId);
  const s = row.settings;
  const [stats, monitoring] = await Promise.all([loadEmailStats(pool, workspaceId, null), loadMonitoring(pool, workspaceId)]);
  const warmupDay = warmupDayFor(row.configured_at, new Date());
  const configured = mailboxOf(row, secrets) !== null;
  return {
    configured,
    /** The provider saved before E1b when it isn't SMTP ("resend"): shown as "not set up". */
    legacyProvider: row.provider === "resend" ? ("resend" as const) : null,
    enabled: row.enabled,
    smtpHost: s.smtpHost ?? "",
    smtpPort: s.smtpPort ?? 465,
    smtpSecurity: smtpSecurityOf(s),
    smtpUsernameConfigured: Boolean(secrets.smtpUsername),
    smtpPasswordConfigured: Boolean(secrets.smtpPassword),
    fromAddress: s.senderAddress ?? "",
    fromName: s.senderName ?? "",
    replyTo: s.replyTo ?? "",
    imapHost: s.imapHost ?? "",
    imapPort: s.imapPort ?? 993,
    imapSecurity: s.imapSecurity ?? "ssl",
    imapSameLogin: s.imapSameLogin ?? true,
    imapUsernameConfigured: Boolean(secrets.imapUsername),
    imapPasswordConfigured: Boolean(secrets.imapPassword),
    imapFolder: s.imapFolder ?? "INBOX",
    dailyCap: row.daily_cap,
    hourlyCap: row.hourly_cap,
    minDelaySeconds: row.min_delay_seconds,
    maxDelaySeconds: row.max_delay_seconds,
    sendWindow: { days: row.send_window_days, start: row.send_window_start.slice(0, 5), end: row.send_window_end.slice(0, 5) },
    alreadyWarmed: row.already_warmed,
    configuredAt: row.configured_at?.toISOString() ?? null,
    warmupDay: row.already_warmed ? null : warmupDay,
    effectiveDailyCap: emailWarmupCap(warmupDay, row.daily_cap, row.already_warmed),
    sentToday: stats.sentToday,
    sentThisHour: stats.sentThisHour,
    pause: configured && !row.enabled ? { reason: row.paused_reason, at: row.paused_at?.toISOString() ?? null, byName: monitoring.pausedByName } : null,
    failures24h: monitoring.failures24h,
    rejections24h: monitoring.rejections24h,
    queuedCount: monitoring.queuedCount,
    safetyEvents: monitoring.safetyEvents,
    daily: monitoring.daily,
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface UpdateEmailSettingsInput {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailSecurity;
  smtpUsername?: string;
  smtpPassword?: string;
  fromAddress: string;
  fromName: string;
  replyTo?: string | null;
  imapHost: string;
  imapPort: number;
  imapSecurity: MailSecurity;
  imapSameLogin: boolean;
  imapUsername?: string;
  imapPassword?: string;
  imapFolder: string;
  dailyCap: number;
  hourlyCap: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  sendWindow: SendWindow;
  alreadyWarmed: boolean;
}

/** Admin only (route guard). Secrets are write-only: blank keeps the saved value. */
export async function updateEmailSettings(actor: Actor, workspaceId: string, input: UpdateEmailSettingsInput) {
  await withTransaction(async (db) => {
    await db.query(`select 1 from public.integration_connections where workspace_id = $1 and id = 'email' for update`, [workspaceId]);
    const { row, secrets: current } = await loadEmailConnection(db, workspaceId);
    const keep = (next: string | undefined, saved: string | undefined) => (next ? next : saved);
    const secrets: EmailSecrets = {
      smtpUsername: keep(input.smtpUsername, current.smtpUsername),
      smtpPassword: keep(input.smtpPassword, current.smtpPassword),
      imapUsername: input.imapSameLogin ? undefined : keep(input.imapUsername, current.imapUsername),
      imapPassword: input.imapSameLogin ? undefined : keep(input.imapPassword, current.imapPassword),
    };
    if (!secrets.smtpUsername || !secrets.smtpPassword) throw new ValidationError("The SMTP username and password are required.");
    if (!input.imapSameLogin && (!secrets.imapUsername || !secrets.imapPassword)) {
      throw new ValidationError("The IMAP username and password are required (or tick \"Same login as SMTP\").");
    }
    const settings: EmailSettingsJson = {
      senderName: input.fromName,
      senderAddress: input.fromAddress,
      replyTo: input.replyTo || null,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpSecurity: input.smtpSecurity,
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapSecurity: input.imapSecurity,
      imapSameLogin: input.imapSameLogin,
      imapFolder: input.imapFolder,
    };
    const encrypted = encryptJson(secrets, "integration:email");
    await db.query(
      `update public.integration_connections
          set provider = 'smtp', settings = $2,
              secret_ciphertext = $3, secret_iv = $4, secret_tag = $5, key_version = $6,
              configured_at = coalesce(configured_at, now()), already_warmed = $7,
              daily_cap = $8, hourly_cap = $9, min_delay_seconds = $10, max_delay_seconds = $11,
              send_window_days = $12::smallint[], send_window_start = $13::time, send_window_end = $14::time,
              updated_by = $15
        where workspace_id = $1 and id = 'email'`,
      [
        workspaceId,
        settings,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        encrypted.keyVersion,
        input.alreadyWarmed,
        input.dailyCap,
        input.hourlyCap,
        input.minDelaySeconds,
        input.maxDelaySeconds,
        [...new Set(input.sendWindow.days)].sort(),
        input.sendWindow.start,
        input.sendWindow.end,
        actor.id,
      ],
    );
    // The switch: on after off is a resume, off after on a pause by this admin.
    const wasOn = row.provider === "smtp" && row.enabled;
    if (input.enabled && !row.enabled) await resumeSending(db, actor, workspaceId);
    if (!input.enabled && (wasOn || row.provider !== "smtp")) {
      const reason = `Paused by ${actor.fullName}.`;
      await db.query(
        `update public.integration_connections set enabled = false, paused_reason = $2, paused_at = now(), paused_by = $3 where workspace_id = $1 and id = 'email'`,
        [workspaceId, reason, actor.id],
      );
      if (wasOn) await recordEmailEvent(db, workspaceId, "paused", reason);
    }
    await recordAdminAudit(db, actor, "connection.email.updated", "integration_connection", `${workspaceId}:email`, {
      enabled: input.enabled,
      smtpHost: input.smtpHost,
      imapHost: input.imapHost,
      dailyCap: input.dailyCap,
      hourlyCap: input.hourlyCap,
      alreadyWarmed: input.alreadyWarmed,
    });
  });
  return getEmailSettings(workspaceId);
}
