import type { Actor } from "../authMiddleware.js";
import type { Queryable } from "../dto.js";
import { recordAdminAudit } from "./admin-audit.service.js";
import type { AutoPauseStats } from "../domain/whatsappSafety.js";

/**
 * E1 WhatsApp safety: the DB side of `domain/whatsappSafety.ts` — the counts
 * `decideSend` / `shouldAutoPause` need, safety events, and auto-pause.
 */

export type SafetyEventKind = "send_failed" | "reconnect_failed" | "disconnected" | "restricted" | "paused" | "resumed";

export async function recordSafetyEvent(db: Queryable, workspaceId: string, kind: SafetyEventKind, detail: string | null = null) {
  await db.query(`insert into public.whatsapp_safety_events (workspace_id, kind, detail) values ($1, $2, $3)`, [workspaceId, kind, detail]);
}

export interface SendStats extends AutoPauseStats {
  sentToday: number;
  newChatsToday: number;
  isFirstMessage: boolean;
}

const IST_MIDNIGHT = `date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`;

/**
 * Everything one send needs, in one query. Signals (failures, reconnects, STOPs,
 * the 24 h sends for the STOP rate) count only after `resumedAt`, so a resume
 * is not undone by the same signals that caused the pause.
 */
export async function loadSendStats(db: Queryable, workspaceId: string, jid: string, phoneE164: string, resumedAt: Date | null): Promise<SendStats> {
  const result = await db.query<{
    sent_today: number;
    new_chats_today: number;
    sends_24h: number;
    stops_24h: number;
    failures_30m: number;
    reconnects_30m: number;
    is_first: boolean;
  }>(
    `with since as (
       select greatest(now() - interval '24 hours', coalesce($4::timestamptz, '-infinity')) as d1,
              greatest(now() - interval '30 minutes', coalesce($4::timestamptz, '-infinity')) as m30
     )
     select
       (select count(*)::int from public.whatsapp_outbound_messages
         where workspace_id = $1 and status = 'sent' and sent_at >= ${IST_MIDNIGHT}) as sent_today,
       (select count(*)::int from public.whatsapp_outbound_messages
         where workspace_id = $1 and status = 'sent' and new_chat and sent_at >= ${IST_MIDNIGHT}) as new_chats_today,
       (select count(*)::int from public.whatsapp_outbound_messages, since
         where workspace_id = $1 and status = 'sent' and sent_at > since.d1) as sends_24h,
       (select count(*)::int from public.whatsapp_inbound_events, since
         where workspace_id = $1 and reply_label = 'asked_to_stop' and received_at > since.d1) as stops_24h,
       (select count(*)::int from public.whatsapp_safety_events, since
         where workspace_id = $1 and kind = 'send_failed' and created_at > since.m30) as failures_30m,
       (select count(*)::int from public.whatsapp_safety_events, since
         where workspace_id = $1 and kind = 'reconnect_failed' and created_at > since.m30) as reconnects_30m,
       not exists (select 1 from public.whatsapp_outbound_messages where workspace_id = $1 and remote_jid = $2 and status = 'sent')
         and not exists (select 1 from public.whatsapp_inbound_events where workspace_id = $1 and sender_phone_e164 = $3) as is_first`,
    [workspaceId, jid, phoneE164, resumedAt],
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
  };
}

/**
 * Turns outbound off (`enabled` = false) with a reason and notifies every active
 * admin — once: only the call that flips `enabled` does anything. Only an admin
 * resumes. Returns whether this call paused.
 */
export async function autoPause(db: Queryable, workspaceId: string, reason: string): Promise<boolean> {
  const paused = await db.query(
    `update public.whatsapp_connection
        set enabled = false, paused_reason = $2, paused_at = now(), paused_by = null
      where workspace_id = $1 and enabled
      returning workspace_id`,
    [workspaceId, reason],
  );
  if (!paused.rowCount) return false;
  await recordSafetyEvent(db, workspaceId, "paused", reason);
  await notifyAdmins(db, workspaceId, "WhatsApp sending paused automatically", `${reason} An admin can resume it in Settings → Workspace → WhatsApp.`);
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

/** Admin only (route guard): turns outbound back on; signals before now no longer count. */
export async function resumeSending(db: Queryable, actor: Actor, workspaceId: string) {
  await db.query(
    `update public.whatsapp_connection
        set enabled = true, paused_reason = null, paused_at = null, paused_by = null, resumed_at = now(), updated_by = $2
      where workspace_id = $1`,
    [workspaceId, actor.id],
  );
  await recordSafetyEvent(db, workspaceId, "resumed", `Resumed by ${actor.fullName}`);
  await recordAdminAudit(db, actor, "connection.whatsapp.resumed", "whatsapp_connection", workspaceId);
}

/** Settings → WhatsApp → Safety: today's counts, 24 h signals, the last 20 events and a 14-day table. */
export async function loadSafetyMonitoring(db: Queryable, workspaceId: string) {
  const [counts, events, days] = await Promise.all([
    db.query<{ new_chats_today: number; failures_24h: number; stops_24h: number; paused_by_name: string | null }>(
      `select
         (select count(*)::int from public.whatsapp_outbound_messages
           where workspace_id = $1 and status = 'sent' and new_chat and sent_at >= ${IST_MIDNIGHT}) as new_chats_today,
         (select count(*)::int from public.whatsapp_safety_events
           where workspace_id = $1 and kind = 'send_failed' and created_at > now() - interval '24 hours') as failures_24h,
         (select count(*)::int from public.whatsapp_inbound_events
           where workspace_id = $1 and reply_label = 'asked_to_stop' and received_at > now() - interval '24 hours') as stops_24h,
         (select p.full_name from public.whatsapp_connection c join public.profiles p on p.id = c.paused_by where c.workspace_id = $1) as paused_by_name`,
      [workspaceId],
    ),
    db.query<{ kind: SafetyEventKind; detail: string | null; created_at: Date }>(
      `select kind, detail, created_at from public.whatsapp_safety_events where workspace_id = $1 order by created_at desc limit 20`,
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
    pausedByName: row.paused_by_name,
    safetyEvents: events.rows.map((e) => ({ kind: e.kind, detail: e.detail, at: e.created_at.toISOString() })),
    daily: days.rows,
  };
}

export interface WhatsAppSafetySettings {
  enabled: boolean;
  dailyCap: number;
  minDelaySeconds?: number;
  maxDelaySeconds?: number;
  maxNewChatsPerDay?: number;
  sendWindow?: { days: number[]; start: string; end: string };
}

/**
 * Admin only (route guard). Turning outbound off records a pause by this admin;
 * turning it back on is a resume.
 */
export async function updateSafetySettings(db: Queryable, actor: Actor, workspaceId: string, input: WhatsAppSafetySettings) {
  const current = await db.query<{ enabled: boolean }>(`select enabled from public.whatsapp_connection where workspace_id = $1 for update`, [workspaceId]);
  const wasEnabled = current.rows[0]?.enabled ?? false;
  await db.query(
    `update public.whatsapp_connection
        set daily_cap = $2,
            min_delay_seconds = coalesce($3, min_delay_seconds),
            max_delay_seconds = coalesce($4, max_delay_seconds),
            max_new_chats_per_day = coalesce($5, max_new_chats_per_day),
            send_window_days = coalesce($6::smallint[], send_window_days),
            send_window_start = coalesce($7::time, send_window_start),
            send_window_end = coalesce($8::time, send_window_end),
            updated_by = $9
      where workspace_id = $1`,
    [
      workspaceId,
      input.dailyCap,
      input.minDelaySeconds ?? null,
      input.maxDelaySeconds ?? null,
      input.maxNewChatsPerDay ?? null,
      input.sendWindow ? [...new Set(input.sendWindow.days)].sort() : null,
      input.sendWindow?.start ?? null,
      input.sendWindow?.end ?? null,
      actor.id,
    ],
  );
  if (input.enabled && !wasEnabled) await resumeSending(db, actor, workspaceId);
  if (!input.enabled && wasEnabled) {
    const reason = `Paused by ${actor.fullName}.`;
    await db.query(
      `update public.whatsapp_connection set enabled = false, paused_reason = $2, paused_at = now(), paused_by = $3 where workspace_id = $1`,
      [workspaceId, reason, actor.id],
    );
    await recordSafetyEvent(db, workspaceId, "paused", reason);
  }
  await recordAdminAudit(db, actor, "connection.whatsapp.settings_updated", "whatsapp_connection", workspaceId, { ...input });
}
