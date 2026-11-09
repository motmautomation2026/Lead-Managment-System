import { randomBytes } from "node:crypto";
import type { Actor } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { env } from "../env.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { decryptText, encryptText } from "../security/encryption.js";
import { recordAdminAudit } from "./admin-audit.service.js";
import { exchangeCodeForTokens, getAuthorizationUrl, type GoogleOAuthClientConfig } from "../providers/google-calendar.provider.js";
import { warmupCap, warmupDayFor } from "../domain/whatsappSafety.js";
import {
  IST_MIDNIGHT,
  loadSafetyMonitoring,
  pauseSending,
  resumeSending,
  updateNumberSettings,
  updateWorkspaceSettings,
  type WhatsAppNumberSettings,
  type WhatsAppWorkspaceSettings,
} from "./whatsappSafety.service.js";
import { addNumber, removeNumber } from "./whatsappNumbers.service.js";

interface WhatsAppNumberRow {
  id: string;
  label: string;
  owner_user_id: string | null;
  owner_name: string | null;
  enabled: boolean;
  desired_state: string;
  status: string;
  connected_phone: string | null;
  display_name: string | null;
  qr_ciphertext: Buffer | null;
  qr_iv: Buffer | null;
  qr_tag: Buffer | null;
  qr_key_version: number;
  qr_expires_at: Date | null;
  last_error: string | null;
  reachout_lock: unknown;
  new_chat_cap: unknown;
  worker_heartbeat_at: Date | null;
  last_connected_at: Date | null;
  last_disconnected_at: Date | null;
  daily_cap: number;
  min_delay_seconds: number;
  max_delay_seconds: number;
  paired_at: Date | null;
  max_new_chats_per_day: number;
  paused_reason: string | null;
  paused_at: Date | null;
  paused_by_name: string | null;
  sent_today: number;
  new_chats_today: number;
  lead_count: number;
  queued_sends: number;
}

/**
 * E4a rule 12: session-pooler client slots. Every connected number holds one session-lock client;
 * the API and the worker each keep a session pool of DB_SESSION_POOL_MAX; a few slots stay free for
 * the Supabase dashboard, scripts and `db:connections --probe`.
 * headroom = SESSION_POOLER_CLIENTS − 2 × DB_SESSION_POOL_MAX − SESSION_SLOT_RESERVE (defaults: 15 − 4 − 3 = 8).
 * shortcut: the pooler size is the staging value from CLAUDE.md, not read from Supabase; make it an env var if production differs.
 */
export const SESSION_POOLER_CLIENTS = 15;
export const SESSION_SLOT_RESERVE = 3;
export function sessionSlotHeadroom(sessionPoolMax: number = env.DB_SESSION_POOL_MAX): number {
  return SESSION_POOLER_CLIENTS - 2 * sessionPoolMax - SESSION_SLOT_RESERVE;
}

function decryptQr(row: WhatsAppNumberRow): string | null {
  return row.qr_ciphertext && row.qr_iv && row.qr_tag && row.qr_expires_at && row.qr_expires_at.getTime() > Date.now()
    ? decryptText({ ciphertext: row.qr_ciphertext, iv: row.qr_iv, tag: row.qr_tag, keyVersion: row.qr_key_version }, "whatsapp:pairing-qr")
    : null;
}

function numberToDto(row: WhatsAppNumberRow) {
  const warmupDay = warmupDayFor(row.paired_at, new Date());
  const newChatCap = row.new_chat_cap as { capping_status?: string; ote_status?: string } | null;
  return {
    id: row.id,
    label: row.label,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    enabled: row.enabled,
    desiredState: row.desired_state,
    status: row.status,
    connectedPhone: row.connected_phone,
    displayName: row.display_name,
    qr: decryptQr(row),
    qrExpiresAt: row.qr_expires_at?.toISOString() ?? null,
    lastError: row.last_error,
    workerHeartbeatAt: row.worker_heartbeat_at?.toISOString() ?? null,
    lastConnectedAt: row.last_connected_at?.toISOString() ?? null,
    lastDisconnectedAt: row.last_disconnected_at?.toISOString() ?? null,
    outboundRestricted: Boolean(
      (row.reachout_lock as { isActive?: boolean } | null)?.isActive || newChatCap?.capping_status === "CAPPED" || newChatCap?.ote_status === "EXHAUSTED",
    ),
    pairedAt: row.paired_at?.toISOString() ?? null,
    warmupDay,
    dailyCap: row.daily_cap,
    effectiveDailyCap: warmupCap(warmupDay, row.daily_cap),
    minDelaySeconds: row.min_delay_seconds,
    maxDelaySeconds: row.max_delay_seconds,
    maxNewChatsPerDay: row.max_new_chats_per_day,
    sentToday: row.sent_today,
    newChatsToday: row.new_chats_today,
    leadCount: row.lead_count,
    queuedSends: row.queued_sends,
    pause: row.enabled ? null : { reason: row.paused_reason, at: row.paused_at?.toISOString() ?? null, byName: row.paused_by_name },
  };
}

/** Every number of the workspace that isn't removed, oldest first, with today's per-number counts. */
async function listNumbers(workspaceId: string) {
  const result = await pool.query<WhatsAppNumberRow>(
    `select n.*, owner.full_name as owner_name, pauser.full_name as paused_by_name,
            (select count(*)::int from public.whatsapp_outbound_messages o
              where o.whatsapp_number_id = n.id and o.status = 'sent' and o.sent_at >= ${IST_MIDNIGHT}) as sent_today,
            (select count(*)::int from public.whatsapp_outbound_messages o
              where o.whatsapp_number_id = n.id and o.status = 'sent' and o.new_chat and o.sent_at >= ${IST_MIDNIGHT}) as new_chats_today,
            (select count(*)::int from public.leads l where l.whatsapp_number_id = n.id) as lead_count,
            (select count(*)::int from public.whatsapp_outbound_messages o where o.whatsapp_number_id = n.id and o.status = 'prepared') as queued_sends
       from public.whatsapp_numbers n
       left join public.profiles owner on owner.id = n.owner_user_id
       left join public.profiles pauser on pauser.id = n.paused_by
      where n.workspace_id = $1 and n.removed_at is null
      order by n.created_at, n.id`,
    [workspaceId],
  );
  return result.rows.map(numberToDto);
}

export async function getWhatsAppConnection(workspaceId: string) {
  const [workspace, numbers, counts, invalid, review, safety, slots] = await Promise.all([
    pool.query<{ outbound_enabled: boolean; max_numbers: number; send_window_days: number[]; send_window_start: string; send_window_end: string }>(
      `select outbound_enabled, max_numbers, send_window_days, send_window_start::text, send_window_end::text
         from public.whatsapp_connection where workspace_id = $1`,
      [workspaceId],
    ),
    listNumbers(workspaceId),
    pool.query<{ today: string; pending: string }>(
      `select
         count(*) filter (where sent_at >= ${IST_MIDNIGHT})::text as today,
         (select count(*)::text from public.scheduled_actions where workspace_id = $1 and action_type = 'send_whatsapp' and status in ('pending','due','executing','paused')) as pending
       from public.whatsapp_outbound_messages
      where workspace_id = $1 and status = 'sent'`,
      [workspaceId],
    ),
    pool.query<{ count: string }>(
      `select count(*)::text as count from public.leads where workspace_id = $1 and nullif(trim(phone), '') is not null and phone_e164 is null`,
      [workspaceId],
    ),
    pool.query<{
      message_id: string;
      sender_phone_e164: string | null;
      message_type: string;
      received_at: Date;
      match_count: number;
      disposition: "unmatched" | "ambiguous";
    }>(
      `select message_id, sender_phone_e164, message_type, received_at, match_count, disposition
         from public.whatsapp_inbound_events
        where workspace_id = $1 and disposition in ('unmatched', 'ambiguous')
        order by received_at desc
        limit 20`,
      [workspaceId],
    ),
    loadSafetyMonitoring(pool, workspaceId),
    // Rule 12: numbers holding (or about to hold) a session-lock client, across every active workspace.
    pool.query<{ count: number }>(
      `select count(*)::int as count
         from public.whatsapp_numbers n join public.workspaces w on w.id = n.workspace_id
        where w.is_active and n.removed_at is null and n.desired_state in ('connected', 'restart')`,
    ),
  ]);
  const ws = workspace.rows[0]!;
  const sessionNumbers = slots.rows[0]!.count;
  const headroom = sessionSlotHeadroom();
  return {
    enabled: ws.outbound_enabled,
    maxNumbers: ws.max_numbers,
    sendWindow: { days: ws.send_window_days, start: ws.send_window_start.slice(0, 5), end: ws.send_window_end.slice(0, 5) },
    numbers,
    sessionSlots: { numbers: sessionNumbers, headroom, overHeadroom: sessionNumbers > headroom },
    todayCount: Number(counts.rows[0]?.today ?? 0),
    pendingCount: Number(counts.rows[0]?.pending ?? 0),
    invalidPhoneCount: Number(invalid.rows[0]?.count ?? 0),
    failures24h: safety.failures24h,
    stops24h: safety.stops24h,
    newChatsToday: safety.newChatsToday,
    safetyEvents: safety.safetyEvents,
    daily: safety.daily,
    inboundReview: review.rows.map((event) => ({
      messageId: event.message_id,
      senderPhoneE164: event.sender_phone_e164,
      messageType: event.message_type,
      receivedAt: event.received_at.toISOString(),
      matchCount: event.match_count,
      disposition: event.disposition,
    })),
  };
}

export async function updateWhatsAppSettings(actor: Actor, workspaceId: string, input: WhatsAppWorkspaceSettings) {
  await withTransaction((db) => updateWorkspaceSettings(db, actor, workspaceId, input));
  return getWhatsAppConnection(workspaceId);
}

async function requireNumber(db: Queryable, workspaceId: string, numberId: string) {
  const found = await db.query(`select 1 from public.whatsapp_numbers where id = $1 and workspace_id = $2 and removed_at is null`, [numberId, workspaceId]);
  if (!found.rowCount) throw new NotFoundError("WhatsApp number");
}

export async function addWhatsAppNumber(actor: Actor, workspaceId: string, input: { label?: string; ownerUserId?: string | null }) {
  if (input.ownerUserId) await requireActiveUser(input.ownerUserId);
  await addNumber(actor, workspaceId, input);
  return getWhatsAppConnection(workspaceId);
}

export async function updateWhatsAppNumber(actor: Actor, workspaceId: string, numberId: string, input: WhatsAppNumberSettings) {
  if (input.ownerUserId) await requireActiveUser(input.ownerUserId);
  const updated = await withTransaction((db) => updateNumberSettings(db, actor, workspaceId, numberId, input));
  if (!updated) throw new NotFoundError("WhatsApp number");
  return getWhatsAppConnection(workspaceId);
}

export async function pauseWhatsAppNumber(actor: Actor, workspaceId: string, numberId: string, pause: boolean) {
  await withTransaction(async (db) => {
    await requireNumber(db, workspaceId, numberId);
    await (pause ? pauseSending : resumeSending)(db, actor, workspaceId, numberId);
  });
  return getWhatsAppConnection(workspaceId);
}

export async function removeWhatsAppNumber(actor: Actor, workspaceId: string, numberId: string, input: { leads?: "move" | "unassign"; moveToNumberId?: string }) {
  await removeNumber(actor, workspaceId, numberId, input);
  return getWhatsAppConnection(workspaceId);
}

export async function commandWhatsApp(actor: Actor, workspaceId: string, numberId: string, command: "connect" | "restart" | "logout") {
  const desired = command === "logout" ? "disconnected" : command === "restart" ? "restart" : "connected";
  await withTransaction(async (db) => {
    const updated = await db.query(
      `update public.whatsapp_numbers
          set desired_state = $1, command_version = command_version + 1, updated_by = $2, updated_at = now(),
              qr_ciphertext = null, qr_iv = null, qr_tag = null, qr_expires_at = null
        where id = $3 and workspace_id = $4 and removed_at is null`,
      [desired, actor.id, numberId, workspaceId],
    );
    if (!updated.rowCount) throw new NotFoundError("WhatsApp number");
    await recordAdminAudit(db, actor, `connection.whatsapp.${command}`, "whatsapp_number", numberId);
  });
  return getWhatsAppConnection(workspaceId);
}

/** A number's owner must be an active CRM user (rule 2; users are not workspace-scoped). */
async function requireActiveUser(userId: string) {
  const found = await pool.query(`select 1 from public.profiles where id = $1 and is_active`, [userId]);
  if (!found.rowCount) throw new ValidationError("The owner must be an active CRM user.");
}

interface GoogleCalendarRow {
  enabled: boolean;
  status: "disconnected" | "connected" | "error";
  client_id: string | null;
  redirect_uri: string | null;
  client_secret_ciphertext: Buffer | null;
  client_secret_iv: Buffer | null;
  client_secret_tag: Buffer | null;
  client_secret_key_version: number;
  connected_email: string | null;
  connected_calendar_id: string;
  refresh_token_ciphertext: Buffer | null;
  refresh_token_iv: Buffer | null;
  refresh_token_tag: Buffer | null;
  refresh_token_key_version: number;
  pending_oauth_state: string | null;
  pending_oauth_state_expires_at: Date | null;
  updated_by: string | null;
  last_error: string | null;
  last_synced_at: Date | null;
  updated_at: Date;
}

async function loadGoogleCalendarRow(workspaceId: string, db: Queryable = pool): Promise<GoogleCalendarRow> {
  const result = await db.query<GoogleCalendarRow>(`select * from public.google_calendar_connection where workspace_id = $1`, [workspaceId]);
  return result.rows[0]!;
}

// AAD strings below are deliberately fixed, not workspace-namespaced — see
// baileys-auth.store.ts's comment: existing secrets were encrypted under
// these exact AAD values before per-workspace scoping shipped, and AES-GCM
// throws on any AAD mismatch. Row-level isolation is already enforced by
// the `where workspace_id = $1` queries these values are read through.
function decryptClientSecret(row: GoogleCalendarRow): string | null {
  if (!row.client_secret_ciphertext || !row.client_secret_iv || !row.client_secret_tag) return null;
  return decryptText(
    { ciphertext: row.client_secret_ciphertext, iv: row.client_secret_iv, tag: row.client_secret_tag, keyVersion: row.client_secret_key_version },
    "integration:google_calendar:client_secret",
  );
}

/** The platform-wide Google OAuth app from the GOOGLE_OAUTH_* env vars (validated all-or-none in env.ts), or null when not configured. */
function platformGoogleOAuthConfig(): GoogleOAuthClientConfig | null {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URI) return null;
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
  };
}

/**
 * Used by meeting-calendar sync (Backend/src/services/meeting-calendar-sync.service.ts)
 * to get both the connected account (refreshToken) and the OAuth app to
 * authenticate as (oauthConfig). The OAuth app is the workspace's own
 * DB-stored client when it has fully entered one (an "advanced" override),
 * otherwise the platform-wide app from the environment — which is what makes
 * the one-click Connect flow work. `oauthConfig` is null only when neither
 * exists. Note a refresh token is bound to the client that issued it, so
 * switching between the two sources requires reconnecting.
 */
export async function loadGoogleCalendarConnection(workspaceId: string, db: Queryable = pool) {
  const row = await loadGoogleCalendarRow(workspaceId, db);
  const refreshToken =
    row.refresh_token_ciphertext && row.refresh_token_iv && row.refresh_token_tag
      ? decryptText(
          { ciphertext: row.refresh_token_ciphertext, iv: row.refresh_token_iv, tag: row.refresh_token_tag, keyVersion: row.refresh_token_key_version },
          "integration:google_calendar:refresh_token",
        )
      : null;
  const clientSecret = decryptClientSecret(row);
  const ownConfig: GoogleOAuthClientConfig | null =
    row.client_id && clientSecret && row.redirect_uri
      ? { clientId: row.client_id, clientSecret, redirectUri: row.redirect_uri }
      : null;
  const oauthConfig = ownConfig ?? platformGoogleOAuthConfig();
  return { row, refreshToken, oauthConfig, usesOwnCredentials: ownConfig !== null };
}

export async function getGoogleCalendarConnection(workspaceId: string) {
  const row = await loadGoogleCalendarRow(workspaceId);
  const clientSecretConfigured = Boolean(row.client_secret_ciphertext);
  const ownCredentialsConfigured = Boolean(row.client_id && clientSecretConfigured && row.redirect_uri);
  const platformConfigured = platformGoogleOAuthConfig() !== null;
  return {
    configured: ownCredentialsConfigured || platformConfigured,
    platformConfigured,
    usesOwnCredentials: ownCredentialsConfigured,
    enabled: row.enabled,
    status: row.status,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    clientSecretConfigured,
    connectedEmail: row.connected_email,
    connectedCalendarId: row.connected_calendar_id,
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface UpdateGoogleCalendarCredentialsInput {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

/** Saves the OAuth app's own credentials, entered per workspace — mirrors the email settings' write-only-secret pattern (an empty clientSecret retains whatever's already saved). */
export async function updateGoogleCalendarCredentials(actor: Actor, workspaceId: string, input: UpdateGoogleCalendarCredentialsInput) {
  if (!input.clientId.trim() || !input.redirectUri.trim()) {
    throw new ValidationError("Client ID and redirect URI are required.");
  }
  const current = await loadGoogleCalendarRow(workspaceId);
  const hasExistingSecret = Boolean(current.client_secret_ciphertext);
  if (!input.clientSecret && !hasExistingSecret) {
    throw new ValidationError("A client secret is required.");
  }

  await withTransaction(async (db) => {
    if (input.clientSecret) {
      const encrypted = encryptText(input.clientSecret, "integration:google_calendar:client_secret");
      await db.query(
        `update public.google_calendar_connection
            set client_id = $1, redirect_uri = $2,
                client_secret_ciphertext = $3, client_secret_iv = $4, client_secret_tag = $5, client_secret_key_version = $6,
                updated_by = $7
          where workspace_id = $8`,
        [input.clientId.trim(), input.redirectUri.trim(), encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.keyVersion, actor.id, workspaceId],
      );
    } else {
      await db.query(
        `update public.google_calendar_connection set client_id = $1, redirect_uri = $2, updated_by = $3 where workspace_id = $4`,
        [input.clientId.trim(), input.redirectUri.trim(), actor.id, workspaceId],
      );
    }
    await recordAdminAudit(db, actor, "connection.google_calendar.credentials_updated", "google_calendar_connection", workspaceId, {
      clientId: input.clientId.trim(),
    });
  });
  return getGoogleCalendarConnection(workspaceId);
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export async function startGoogleCalendarOAuth(actor: Actor, workspaceId: string) {
  const { oauthConfig } = await loadGoogleCalendarConnection(workspaceId);
  if (!oauthConfig) {
    throw new ValidationError("Google Calendar isn't set up on this server yet. Ask your administrator to configure it.");
  }
  const state = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
  await pool.query(
    `update public.google_calendar_connection
        set pending_oauth_state = $1, pending_oauth_state_expires_at = $2, updated_by = $3
      where workspace_id = $4`,
    [state, expiresAt, actor.id, workspaceId],
  );
  return { url: getAuthorizationUrl(oauthConfig, state) };
}

/**
 * Handles Google's OAuth redirect. Unauthenticated by necessity (Google's
 * browser redirect carries no bearer token, and no X-Workspace-Id header) —
 * the signed-nonce `state` round-tripped through Google is both this call's
 * only proof the request belongs to a legitimate connect flow, AND (since
 * google_calendar_connection is now one row per workspace) how the
 * originating workspace is recovered: whichever workspace's row has this
 * exact pending state is the one being completed.
 */
export async function completeGoogleCalendarOAuth(code: string, state: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const matched = await pool.query<{ workspace_id: string }>(
    `select workspace_id from public.google_calendar_connection where pending_oauth_state = $1`,
    [state],
  );
  const workspaceId = matched.rows[0]?.workspace_id;
  if (!workspaceId) {
    return { ok: false, error: "Invalid or already-used connection request. Please try connecting again." };
  }

  const { row, oauthConfig } = await loadGoogleCalendarConnection(workspaceId);
  if (!row.pending_oauth_state_expires_at || row.pending_oauth_state_expires_at.getTime() < Date.now()) {
    return { ok: false, error: "This connection request expired. Please try connecting again." };
  }
  if (!oauthConfig) {
    return { ok: false, error: "Google Calendar isn't set up on this server anymore. Ask your administrator to configure it." };
  }

  try {
    const { refreshToken, email } = await exchangeCodeForTokens(oauthConfig, code);
    const encrypted = encryptText(refreshToken, "integration:google_calendar:refresh_token");
    await withTransaction(async (db) => {
      await db.query(
        `update public.google_calendar_connection
            set status = 'connected', enabled = true, connected_email = $1,
                refresh_token_ciphertext = $2, refresh_token_iv = $3, refresh_token_tag = $4, refresh_token_key_version = $5,
                pending_oauth_state = null, pending_oauth_state_expires_at = null,
                last_error = null, last_synced_at = now()
          where workspace_id = $6`,
        [email, encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.keyVersion, workspaceId],
      );
      await recordGoogleCalendarAudit(db, row.updated_by, workspaceId, "connection.google_calendar.connected", { email });
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to connect Google Calendar.";
    await withTransaction(async (db) => {
      await db.query(
        `update public.google_calendar_connection
            set status = 'error', last_error = $1, pending_oauth_state = null, pending_oauth_state_expires_at = null
          where workspace_id = $2`,
        [message, workspaceId],
      );
      await recordGoogleCalendarAudit(db, row.updated_by, workspaceId, "connection.google_calendar.connect_failed", { error: message });
    });
    return { ok: false, error: message };
  }
}

/**
 * Called when Google rejects the stored refresh token (user revoked access, or
 * it expired). Flags the connection as errored so the settings page shows a
 * Reconnect prompt, and clears the dead token so later meetings skip sync
 * cleanly instead of failing against Google every time.
 */
export async function markGoogleCalendarReauthRequired(workspaceId: string, message: string) {
  await pool.query(
    `update public.google_calendar_connection
        set status = 'error', enabled = false, last_error = $1,
            refresh_token_ciphertext = null, refresh_token_iv = null, refresh_token_tag = null
      where workspace_id = $2 and status = 'connected'`,
    [message, workspaceId],
  );
}

/** Revokes the connected account only — the OAuth app's own client_id/client_secret/redirect_uri stay saved so reconnecting doesn't require re-entering them. */
export async function disconnectGoogleCalendar(actor: Actor, workspaceId: string) {
  await withTransaction(async (db) => {
    await db.query(
      `update public.google_calendar_connection
          set status = 'disconnected', enabled = false, connected_email = null,
              refresh_token_ciphertext = null, refresh_token_iv = null, refresh_token_tag = null,
              pending_oauth_state = null, pending_oauth_state_expires_at = null, last_error = null,
              updated_by = $1
        where workspace_id = $2`,
      [actor.id, workspaceId],
    );
    await recordAdminAudit(db, actor, "connection.google_calendar.disconnected", "google_calendar_connection", workspaceId);
  });
  return getGoogleCalendarConnection(workspaceId);
}

/** recordAdminAudit needs a full Actor, but the OAuth callback that completes the connect flow has none — only the admin id captured when the flow started. */
async function recordGoogleCalendarAudit(db: Queryable, adminId: string | null, workspaceId: string, action: string, metadata: Record<string, unknown>) {
  let actorEmail = "unknown";
  if (adminId) {
    const result = await db.query<{ email: string }>(`select email from public.profiles where id = $1`, [adminId]);
    actorEmail = result.rows[0]?.email ?? actorEmail;
  }
  await db.query(
    `insert into public.admin_audit_events (actor_id, actor_email, action, target_type, target_id, metadata)
     values ($1, $2, $3, 'google_calendar_connection', $4, $5)`,
    [adminId, actorEmail, action, workspaceId, metadata],
  );
}
