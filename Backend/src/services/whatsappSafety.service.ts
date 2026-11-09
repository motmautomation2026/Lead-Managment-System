import type { Actor } from "../authMiddleware.js";
import type { Queryable } from "../dto.js";
import { recordAdminAudit } from "./admin-audit.service.js";
import type { AutoPauseStats } from "../domain/whatsappSafety.js";

/**
 * E1 WhatsApp safety: the DB side of `domain/whatsappSafety.ts` — the counts
 * `decideSend` / `shouldAutoPause` need, safety events, and auto-pause.
 */

export type SafetyEventKind = "send_failed" | "reconnect_failed" | "disconnected" | "restricted" | "paused" | "resumed";

/** E4a: `numberId` = the number the signal belongs to (its auto-pause counts only its own signals). */
export async function recordSafetyEvent(db: Queryable, workspaceId: string, numberId: string | null, kind: SafetyEventKind, detail: string | null = null) {
  await db.query(`insert into public.whatsapp_safety_events (workspace_id, whatsapp_number_id, kind, detail) values ($1, $2, $3, $4)`, [
    workspaceId,
    numberId,
    kind,
    detail,
  ]);
}

export interface SendStats extends AutoPauseStats {
  sentToday: number;
  newChatsToday: number;
  /** The workspace never messaged / heard from this phone (link block + opt-out line, per lead as before). */
  isFirstMessage: boolean;
  /** E4a: this number never messaged / heard from this phone (its new-chat limit). */
  isNewChat: boolean;
}

export const IST_MIDNIGHT = `date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`;

/**
 * Everything one send needs, in one query, counted per NUMBER (E4a; indexes from 054) except
 * `is_first`, which stays per workspace. Signals (failures, reconnects, STOPs, the 24 h sends for
 * the STOP rate) count only after `resumedAt`, so a resume is not undone by the same signals.
 */
export async function loadSendStats(
  db: Queryable,
  workspaceId: string,
  numberId: string,
  jid: string,
  phoneE164: string,
  resumedAt: Date | null,
): Promise<SendStats> {
  const result = await db.query<{
    sent_today: number;
    new_chats_today: number;
    sends_24h: number;
    stops_24h: number;
    failures_30m: number;
    reconnects_30m: number;
    is_first: boolean;
    is_new_chat: boolean;
  }>(
    `with since as (
       select greatest(now() - interval '24 hours', coalesce($4::timestamptz, '-infinity')) as d1,
              greatest(now() - interval '30 minutes', coalesce($4::timestamptz, '-infinity')) as m30
     )
     select
       (select count(*)::int from public.whatsapp_outbound_messages
         where whatsapp_number_id = $5 and status = 'sent' and sent_at >= ${IST_MIDNIGHT}) as sent_today,
       (select count(*)::int from public.whatsapp_outbound_messages
         where whatsapp_number_id = $5 and status = 'sent' and new_chat and sent_at >= ${IST_MIDNIGHT}) as new_chats_today,
       (select count(*)::int from public.whatsapp_outbound_messages, since
         where whatsapp_number_id = $5 and status = 'sent' and sent_at > since.d1) as sends_24h,
       (select count(*)::int from public.whatsapp_inbound_events, since
         where whatsapp_number_id = $5 and reply_label = 'asked_to_stop' and received_at > since.d1) as stops_24h,
       (select count(*)::int from public.whatsapp_safety_events, since
         where whatsapp_number_id = $5 and kind = 'send_failed' and created_at > since.m30) as failures_30m,
       (select count(*)::int from public.whatsapp_safety_events, since
         where whatsapp_number_id = $5 and kind = 'reconnect_failed' and created_at > since.m30) as reconnects_30m,
       not exists (select 1 from public.whatsapp_outbound_messages where workspace_id = $1 and remote_jid = $2 and status = 'sent')
         and not exists (select 1 from public.whatsapp_inbound_events where workspace_id = $1 and sender_phone_e164 = $3) as is_first,
       not exists (select 1 from public.whatsapp_outbound_messages where whatsapp_number_id = $5 and remote_jid = $2 and status = 'sent')
         and not exists (select 1 from public.whatsapp_inbound_events where whatsapp_number_id = $5 and sender_phone_e164 = $3) as is_new_chat`,
    [workspaceId, jid, phoneE164, resumedAt, numberId],
  );
  const row = result.rows[0]!;
  return {
    sentToday: row.sent_today,
    newChatsToday: row.new_chats_today,
    sends24h: row.sends_24h,
    stops24h: row.stops_24h,
    failures30m: row.failures_30m,
    reconnectFailures30m: row.reconnects_30m,
    isFirstMessage: row.is_first,
    isNewChat: row.is_new_chat,
  };
}

/**
 * Turns one number's outbound off (`enabled` = false) with a reason and notifies every active
 * admin — once: only the call that flips `enabled` does anything. Only an admin resumes. The
 * workspace's other numbers keep sending. Returns whether this call paused.
 */
export async function autoPause(db: Queryable, workspaceId: string, numberId: string, reason: string): Promise<boolean> {
  const paused = await db.query<{ label: string }>(
    `update public.whatsapp_numbers
        set enabled = false, paused_reason = $3, paused_at = now(), paused_by = null, updated_at = now()
      where id = $2 and workspace_id = $1 and enabled
      returning label`,
    [workspaceId, numberId, reason],
  );
  if (!paused.rowCount) return false;
  await recordSafetyEvent(db, workspaceId, numberId, "paused", reason);
  await notifyAdmins(
    db,
    workspaceId,
    `WhatsApp number ${paused.rows[0]!.label} paused automatically`,
    `${reason} An admin can resume it in Settings → Workspace → WhatsApp.`,
  );
  return true;
}

/** A warning notification to every active admin, linking to Settings. */
export async function notifyAdmins(db: Queryable, workspaceId: string, title: string, detail: string) {
  await db.query(
    `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, href)
     select $1, p.id, $2, $3, 'warning', '/settings'
       from public.profiles p where p.role = 'admin' and p.is_active`,
    [workspaceId, title, detail],
  );
}

/** Admin only (route guard): turns one number's outbound back on; its signals before now no longer count. */
export async function resumeSending(db: Queryable, actor: Actor, workspaceId: string, numberId: string) {
  await db.query(
    `update public.whatsapp_numbers
        set enabled = true, paused_reason = null, paused_at = null, paused_by = null, resumed_at = now(), updated_by = $3, updated_at = now()
      where id = $2 and workspace_id = $1`,
    [workspaceId, numberId, actor.id],
  );
  await recordSafetyEvent(db, workspaceId, numberId, "resumed", `Resumed by ${actor.fullName}`);
  await recordAdminAudit(db, actor, "connection.whatsapp.resumed", "whatsapp_number", numberId);
}

/** Admin only (route guard): pauses one number by hand (only an admin resumes it). */
export async function pauseSending(db: Queryable, actor: Actor, workspaceId: string, numberId: string) {
  const reason = `Paused by ${actor.fullName}.`;
  const paused = await db.query(
    `update public.whatsapp_numbers set enabled = false, paused_reason = $3, paused_at = now(), paused_by = $4, updated_at = now()
      where id = $2 and workspace_id = $1 and enabled`,
    [workspaceId, numberId, reason, actor.id],
  );
  if (paused.rowCount) await recordSafetyEvent(db, workspaceId, numberId, "paused", reason);
  await recordAdminAudit(db, actor, "connection.whatsapp.paused", "whatsapp_number", numberId);
}

/** Settings → WhatsApp → Safety: today's counts, 24 h signals, the last 20 events and a 14-day table. */
export async function loadSafetyMonitoring(db: Queryable, workspaceId: string) {
  const [counts, events, days] = await Promise.all([
    db.query<{ new_chats_today: number; failures_24h: number; stops_24h: number }>(
      `select
         (select count(*)::int from public.whatsapp_outbound_messages
           where workspace_id = $1 and status = 'sent' and new_chat and sent_at >= ${IST_MIDNIGHT}) as new_chats_today,
         (select count(*)::int from public.whatsapp_safety_events
           where workspace_id = $1 and kind = 'send_failed' and created_at > now() - interval '24 hours') as failures_24h,
         (select count(*)::int from public.whatsapp_inbound_events
           where workspace_id = $1 and reply_label = 'asked_to_stop' and received_at > now() - interval '24 hours') as stops_24h`,
      [workspaceId],
    ),
    db.query<{ kind: SafetyEventKind; detail: string | null; created_at: Date; number_label: string | null }>(
      `select e.kind, e.detail, e.created_at, n.label as number_label
         from public.whatsapp_safety_events e left join public.whatsapp_numbers n on n.id = e.whatsapp_number_id
        where e.workspace_id = $1 order by e.created_at desc limit 20`,
      [workspaceId],
    ),
    db.query<{ date: string; sent: number; failed: number; stops: number }>(
      `with days as (
         select d::date as d, d at time zone 'Asia/Kolkata' as from_at, (d + interval '1 day') at time zone 'Asia/Kolkata' as to_at
           from generate_series(date_trunc('day', now() at time zone 'Asia/Kolkata') - interval '13 days',
                                date_trunc('day', now() at time zone 'Asia/Kolkata'), interval '1 day') d
       )
       select d::text as date,
         (select count(*)::int from public.whatsapp_outbound_messages o
           where o.workspace_id = $1 and o.status = 'sent' and o.sent_at >= from_at and o.sent_at < to_at) as sent,
         (select count(*)::int from public.whatsapp_safety_events e
           where e.workspace_id = $1 and e.kind = 'send_failed' and e.created_at >= from_at and e.created_at < to_at) as failed,
         (select count(*)::int from public.whatsapp_inbound_events i
           where i.workspace_id = $1 and i.reply_label = 'asked_to_stop' and i.received_at >= from_at and i.received_at < to_at) as stops
       from days order by d desc`,
      [workspaceId],
    ),
  ]);
  const row = counts.rows[0]!;
  return {
    newChatsToday: row.new_chats_today,
    failures24h: row.failures_24h,
    stops24h: row.stops_24h,
    safetyEvents: events.rows.map((e) => ({ kind: e.kind, detail: e.detail, at: e.created_at.toISOString(), numberLabel: e.number_label })),
    daily: days.rows,
  };
}

/** Workspace-level WhatsApp settings (rule 1): the master switch, the send window, max numbers. */
export interface WhatsAppWorkspaceSettings {
  enabled: boolean;
  sendWindow?: { days: number[]; start: string; end: string };
  maxNumbers?: number;
}

/** Admin only (route guard). `enabled` = the master switch for every number of the workspace. */
export async function updateWorkspaceSettings(db: Queryable, actor: Actor, workspaceId: string, input: WhatsAppWorkspaceSettings) {
  await db.query(
    `update public.whatsapp_connection
        set outbound_enabled = $2,
            send_window_days = coalesce($3::smallint[], send_window_days),
            send_window_start = coalesce($4::time, send_window_start),
            send_window_end = coalesce($5::time, send_window_end),
            max_numbers = coalesce($6, max_numbers),
            updated_by = $7, updated_at = now()
      where workspace_id = $1`,
    [
      workspaceId,
      input.enabled,
      input.sendWindow ? [...new Set(input.sendWindow.days)].sort() : null,
      input.sendWindow?.start ?? null,
      input.sendWindow?.end ?? null,
      input.maxNumbers ?? null,
      actor.id,
    ],
  );
  await recordAdminAudit(db, actor, "connection.whatsapp.settings_updated", "whatsapp_connection", workspaceId, { ...input });
}

/** One number's admin settings (rules 1, 2): label, owner, daily cap, spacing, new-chat limit. */
export interface WhatsAppNumberSettings {
  label?: string;
  ownerUserId?: string | null;
  dailyCap?: number;
  minDelaySeconds?: number;
  maxDelaySeconds?: number;
  maxNewChatsPerDay?: number;
}

/** Admin only (route guard). Returns false when the number isn't in this workspace (or was removed). */
export async function updateNumberSettings(db: Queryable, actor: Actor, workspaceId: string, numberId: string, input: WhatsAppNumberSettings): Promise<boolean> {
  const updated = await db.query(
    `update public.whatsapp_numbers
        set label = coalesce($3, label),
            owner_user_id = case when $4::boolean then $5::uuid else owner_user_id end,
            daily_cap = coalesce($6, daily_cap),
            min_delay_seconds = coalesce($7, min_delay_seconds),
            max_delay_seconds = coalesce($8, max_delay_seconds),
            max_new_chats_per_day = coalesce($9, max_new_chats_per_day),
            updated_by = $10, updated_at = now()
      where id = $2 and workspace_id = $1 and removed_at is null`,
    [
      workspaceId,
      numberId,
      input.label?.trim() ?? null,
      input.ownerUserId !== undefined,
      input.ownerUserId ?? null,
      input.dailyCap ?? null,
      input.minDelaySeconds ?? null,
      input.maxDelaySeconds ?? null,
      input.maxNewChatsPerDay ?? null,
      actor.id,
    ],
  );
  if (!updated.rowCount) return false;
  await recordAdminAudit(db, actor, "connection.whatsapp.number_updated", "whatsapp_number", numberId, { ...input });
  return true;
}
