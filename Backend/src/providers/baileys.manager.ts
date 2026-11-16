import makeWASocket, {
  Browsers,
  DisconnectReason,
  generateMessageIDV2,
  makeCacheableSignalKeyStore,
  proto,
  type AnyMessageContent,
  type CacheStore,
  type ConnectionState,
  type WASocket,
} from "baileys";
import pino from "pino";
import { Client } from "pg";
import { sessionConnectionOptions, pool, WA_LOCK_APPLICATION_NAME, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { phoneE164ToJid } from "../domain/phone.js";
import { decryptBytes, encryptBytes } from "../security/encryption.js";
import { clearBaileysAuthState, loadBaileysAuthState } from "./baileys-auth.store.js";
import { PermanentProviderError, ProviderDeferredError, SendCancelledError } from "./provider-errors.js";
import { processInboundUpsert } from "../services/whatsapp-inbound.service.js";
import { disconnectAction, isOutboundRestricted, randomSpacingMs, reconnectDelayMs, type DisconnectAction } from "../domain/baileys-policy.js";
import { supabaseAdmin } from "../supabaseAdmin.js";
import { decideSend, shouldAutoPause, warmupDayFor, type SafetySource } from "../domain/whatsappSafety.js";
import { autoPause, loadSendStats, notifyAdmins, recordSafetyEvent } from "../services/whatsappSafety.service.js";
import { agentSendRecheck } from "../services/agentSendState.service.js";
import { recordWhatsAppFact } from "../services/messageFacts.service.js";
import { ASSET_MISSING_REASON, ASSET_TOO_BIG_REASON, ATTACHMENT_MISSING, MAX_ATTACHMENT_BYTES } from "../agent/assetRules.js";
import { isMissingStorageObject } from "./storageErrors.js";
import { contactSendProblem } from "../domain/replyDrafts.js";
import { numberPhoneLockKey } from "../domain/whatsappNumbers.js";

export interface WhatsAppAttachment {
  storagePath: string;
  fileName: string;
  mimeType: string;
  bucket: string;
}

/**
 * What this send is for. `scheduled_action` is the original workflow-driven
 * path (idempotency/eligibility keyed off a real `scheduled_actions` row).
 * `proposal` and `meeting` are human-initiated sends with no scheduled
 * action behind them (each needs a template resolved at send time rather
 * than fixed at workflow-definition time) — their outbound rows are keyed
 * off `whatsapp_outbound_messages.proposal_id`/`meeting_id` instead. Every
 * shared safety mechanism below (emergency switch, daily cap, spacing,
 * connection checks) stays computed generically across the whole table
 * regardless of which source a row came from.
 */
export type WhatsAppSendSource =
  | { type: "scheduled_action"; id: string }
  | { type: "proposal"; id: string }
  | { type: "meeting"; id: string }
  /** E2: an AI decision (automated); `id` is the agent_decisions id. */
  | { type: "agent"; id: string }
  /** E3b-2a: a rep's Send of an AI reply draft (send window applies); `id` is the reply_drafts id. */
  | { type: "reply_draft"; id: string }
  /** LL-2: a meeting reminder / "Updated" confirmation (service message: the `meeting` safety rules); `id` is the meeting_reminders id. */
  | { type: "meeting_reminder"; id: string };

export function sourceColumn(
  source: WhatsAppSendSource,
): "scheduled_action_id" | "proposal_id" | "meeting_id" | "agent_decision_id" | "reply_draft_id" | "meeting_reminder_id" {
  if (source.type === "scheduled_action") return "scheduled_action_id";
  if (source.type === "proposal") return "proposal_id";
  if (source.type === "agent") return "agent_decision_id";
  if (source.type === "reply_draft") return "reply_draft_id";
  if (source.type === "meeting_reminder") return "meeting_reminder_id";
  return "meeting_id";
}

/** LL-2: a meeting reminder is a service message: the rep-initiated `meeting` safety rules (no send window; spacing, caps, warm-up, pause). */
export function safetySourceOf(source: WhatsAppSendSource): SafetySource {
  return source.type === "meeting_reminder" ? "meeting" : source.type;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled WhatsApp send source: ${JSON.stringify(value)}`);
}

const INELIGIBLE_MEETING_STATUSES = ["cancelled", "no_show", "failed"];
const INELIGIBLE_MEETING_LIFECYCLES = ["do_not_contact", "merged"];

export interface MeetingSendRow {
  notify_whatsapp_status: string;
  meeting_status: string;
  lifecycle_state: string;
  phone_e164: string | null;
}

/** A meeting notification may go out only while still claimed and the meeting and lead are still live. */
export function isMeetingSendEligible(row: MeetingSendRow): boolean {
  return (
    row.notify_whatsapp_status === "sending" &&
    !INELIGIBLE_MEETING_STATUSES.includes(row.meeting_status) &&
    !INELIGIBLE_MEETING_LIFECYCLES.includes(row.lifecycle_state)
  );
}

// A contact who asked to stop on WhatsApp (D4a) gets no WhatsApp, even from a rep's button.
const NOT_OPTED_OUT = `not exists (select 1 from public.lead_contact_channels c where c.lead_id = l.id and c.channel = 'whatsapp' and c.status = 'opted_out')`;

/**
 * Re-checks, under row locks, that the source still allows this send, and
 * returns the lead's current phone (null when ineligible) for the caller's
 * target-phone check. Must run inside the claim transaction.
 */
export async function loadSourceEligibility(db: Queryable, workspaceId: string, source: WhatsAppSendSource): Promise<string | null> {
  switch (source.type) {
    case "scheduled_action": {
      const result = await db.query<{ phone_e164: string | null }>(
        `select l.phone_e164
           from public.scheduled_actions a
           join public.leads l on l.id = a.lead_id
           join public.workflow_runs r on r.id = a.workflow_run_id
          where a.id = $1 and a.workspace_id = $2 and a.status = 'executing'
            and l.lifecycle_state = 'active' and l.automation_mode not in ('manual','paused','stopped')
            and r.status in ('running','waiting')
          for update of a, l, r`,
        [source.id, workspaceId],
      );
      return result.rows[0]?.phone_e164 ?? null;
    }
    case "proposal": {
      const result = await db.query<{ phone_e164: string | null }>(
        // A human clicked "Send" on this proposal — no automation_mode
        // gate (that gate restrains the automation engine, not a
        // person), only the DNC safety check every customer-facing
        // action must honor.
        `select l.phone_e164
           from public.proposals p
           join public.leads l on l.id = p.lead_id
          where p.id = $1 and p.workspace_id = $2 and p.whatsapp_send_status = 'sending'
            and l.lifecycle_state != 'do_not_contact' and ${NOT_OPTED_OUT}
          for update of p, l`,
        [source.id, workspaceId],
      );
      return result.rows[0]?.phone_e164 ?? null;
    }
    case "meeting": {
      // Human-initiated like proposals (no automation_mode gate). Conditions
      // are checked in isMeetingSendEligible so they are unit-testable.
      const result = await db.query<MeetingSendRow>(
        `select m.notify_whatsapp_status, m.status::text as meeting_status, l.lifecycle_state::text as lifecycle_state, l.phone_e164
           from public.meetings m
           join public.leads l on l.id = m.lead_id
          where m.id = $1 and m.workspace_id = $2 and ${NOT_OPTED_OUT}
          for update of m, l`,
        [source.id, workspaceId],
      );
      const row = result.rows[0];
      return row && isMeetingSendEligible(row) ? row.phone_e164 : null;
    }
    case "agent":
      // performSend re-checks AI sends with agentSendRecheck (it can defer or cancel, not only refuse).
      throw new Error("AI sends are checked by agentSendRecheck.");
    case "reply_draft": {
      // E3b-2a: the rep sent it (no automation_mode gate); opt-out, DNC and channel status still apply.
      const result = await db.query<{ phone_e164: string | null; lifecycle_state: string; whatsapp_status: string | null; phone_status: string | null }>(
        `select l.phone_e164, l.lifecycle_state::text as lifecycle_state, cw.status as whatsapp_status, cp.status as phone_status
           from public.reply_drafts d
           join public.leads l on l.id = d.lead_id
           left join public.lead_contact_channels cw on cw.lead_id = l.id and cw.channel = 'whatsapp'
           left join public.lead_contact_channels cp on cp.lead_id = l.id and cp.channel = 'phone'
          where d.id = $1 and d.workspace_id = $2 and d.send_status = 'sending'
          for update of d, l`,
        [source.id, workspaceId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const problem = contactSendProblem({ channel: "whatsapp", lifecycleState: row.lifecycle_state, channelStatus: row.whatsapp_status, phoneStatus: row.phone_status, address: row.phone_e164 });
      return problem ? null : row.phone_e164;
    }
    case "meeting_reminder": {
      // LL-2: still claimed, the meeting still scheduled at the reminder's time and not started, not DNC / merged / opted out.
      const result = await db.query<{ phone_e164: string | null }>(
        `select l.phone_e164
           from public.meeting_reminders r
           join public.meetings m on m.id = r.meeting_id and m.status = 'scheduled' and m.scheduled_at = r.meeting_at and m.scheduled_at > now()
           join public.leads l on l.id = r.lead_id
          where r.id = $1 and r.workspace_id = $2 and r.status = 'sending'
            and l.lifecycle_state not in ('do_not_contact', 'merged') and ${NOT_OPTED_OUT}
          for update of r, l`,
        [source.id, workspaceId],
      );
      return result.rows[0]?.phone_e164 ?? null;
    }
    default:
      return assertNever(source);
  }
}

/** The lead a send is for, used to mark its WhatsApp channel invalid when the number is not registered. */
export async function resolveLeadIdForSource(db: Queryable, source: WhatsAppSendSource): Promise<string | null> {
  let table: string;
  switch (source.type) {
    case "scheduled_action":
      table = "public.scheduled_actions";
      break;
    case "proposal":
      table = "public.proposals";
      break;
    case "meeting":
      table = "public.meetings";
      break;
    case "agent":
      table = "public.agent_decisions";
      break;
    case "reply_draft":
      table = "public.reply_drafts";
      break;
    case "meeting_reminder":
      table = "public.meeting_reminders";
      break;
    default:
      return assertNever(source);
  }
  const result = await db.query<{ lead_id: string }>(`select lead_id from ${table} where id = $1`, [source.id]);
  return result.rows[0]?.lead_id ?? null;
}

/**
 * Log redaction for the manager and Baileys. The log message text (`msg`) and
 * error messages stay readable; WhatsApp message content and credentials do not:
 * - message protos: `message`/`messages`/`fullMessage` (Baileys' WAMessage
 *   fields; `*.message` only when not a string, so `err.message` survives)
 * - content leaves if logged loose: text, caption, conversation, body (our send input), content
 * - credentials: qr, auth, creds, signal `keys`, noise `handshake`, `protocolMsg`
 *   (app-state sync key shares), and `key` (defensive; Baileys uses it for message keys)
 */
export const BAILEYS_LOG_REDACTION: pino.LoggerOptions["redact"] = {
  paths: [
    "message", "*.message", "messages", "*.messages", "fullMessage", "*.fullMessage",
    "text", "*.text", "caption", "*.caption", "conversation", "*.conversation", "body", "*.body", "content", "*.content",
    "qr", "auth", "creds", "*.creds", "keys", "*.keys", "handshake", "protocolMsg", "key", "*.key",
  ],
  censor: (value: unknown, path: string[]) => (path.length > 1 && path.at(-1) === "message" && typeof value === "string" ? value : "[Redacted]"),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function disconnectCode(update: Partial<ConnectionState>) {
  const error = update.lastDisconnect?.error as Error & { output?: { statusCode?: number }; statusCode?: number };
  return error?.output?.statusCode ?? error?.statusCode;
}

function jsonSafe(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (nested instanceof Date ? nested.toISOString() : nested))) as unknown;
}

/** E4a: the number's row (whatsapp_numbers) + the workspace's window and master switch (whatsapp_connection). */
interface ConnectionControl {
  label: string;
  enabled: boolean;
  outbound_enabled: boolean;
  desired_state: "connected" | "disconnected" | "restart";
  command_version: string;
  status: string;
  daily_cap: number;
  min_delay_seconds: number;
  max_delay_seconds: number;
  reachout_lock: { isActive?: boolean } | null;
  new_chat_cap: { capping_status?: string; ote_status?: string } | null;
  paired_at: Date | null;
  max_new_chats_per_day: number;
  send_window_days: number[];
  send_window_start: string;
  send_window_end: string;
  next_send_at: Date | null;
  paused_reason: string | null;
  resumed_at: Date | null;
}

const RESTRICTED_REASON = "WhatsApp applied a reach-out or new-chat restriction to this number.";
const MASTER_OFF_REASON = "WhatsApp outbound is switched off for this workspace.";

/** One number's control row with its workspace's send window and master switch. */
const CONTROL_SQL = `select n.*, c.outbound_enabled, c.send_window_days, c.send_window_start, c.send_window_end
   from public.whatsapp_numbers n
   join public.whatsapp_connection c on c.workspace_id = n.workspace_id
  where n.id = $1`;

/** B1: "composing" expires after ~10 s, so it is resent at most every 8 s. */
const COMPOSING_REFRESH_MS = 8_000;

/**
 * B7: numbers paired before E1 keep the browser identity they were paired with
 * (changing it on a live session is not worth the risk); new pairings use a
 * standard preset. The WA Web version is the one pinned in the installed
 * Baileys release — never fetched per connect.
 */
const LEGACY_BROWSER: [string, string, string] = ["Northbeam CRM", "Chrome", "1.0.0"];
const PAIRING_BROWSER = Browsers.macOS("Chrome");

/** Closes we never reconnect from (B4): status, whether auth is cleared, what admins are told. */
const STOP_ON_DISCONNECT: Record<Exclude<DisconnectAction, "reconnect" | "reconnect_now">, { clearAuth: boolean; pause: boolean; reason: string }> = {
  logged_out: { clearAuth: true, pause: true, reason: "WhatsApp logged this number out. Pair it again in Settings → WhatsApp." },
  pause: { clearAuth: false, pause: true, reason: "WhatsApp closed the session (forbidden or replaced by another session). The number may be restricted." },
  repair: { clearAuth: true, pause: false, reason: "The WhatsApp session is broken and needs to be paired again." },
};

/**
 * B5: one retry-counter cache per number for the life of the process, outside
 * any socket, so a reconnect can't reset counters into an endless retry loop.
 * shortcut: a size-capped Map without TTL; switch to a TTL cache if retries grow large.
 */
const retryCounterCaches = new Map<string, CacheStore>();
export function retryCounterCache(numberId: string): CacheStore {
  let cache = retryCounterCaches.get(numberId);
  if (!cache) {
    const values = new Map<string, unknown>();
    cache = {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: <T>(key: string, value: T) => {
        if (values.size >= 10_000) values.clear();
        values.set(key, value);
      },
      del: (key: string) => void values.delete(key),
      flushAll: () => values.clear(),
    };
    retryCounterCaches.set(numberId, cache);
  }
  return cache;
}

/** The claim transaction's outcome; errors are thrown after it commits. */
type Claim =
  | { kind: "alreadySent"; messageId: string }
  | { kind: "defer"; reason: string; retryAfterMs: number }
  | { kind: "permanent"; reason: string }
  /** E2: the AI send's re-check refused it at send time. */
  | { kind: "cancel"; reason: string }
  | {
      kind: "send";
      messageId: string;
      /** The JID onWhatsApp returned (B2); WhatsApp may normalise the number. */
      sendJid: string;
      text: string;
      typingMs: number;
      spacingMs: number;
      newChat: boolean;
      minDelaySeconds: number;
      maxDelaySeconds: number;
    };

interface OutboundRow {
  message_id: string;
  remote_jid: string;
  status: "prepared" | "sent" | "failed";
}

/**
 * One instance per WhatsApp NUMBER (E4a; see baileys-registry.ts) — each number
 * owns its own session, its own Postgres advisory lock (keyed off the number
 * id), its own auth state and its own control row in whatsapp_numbers. The
 * daily cap, spacing, new chats, warm-up and auto-pause are counted per number;
 * the send window and the master switch come from the workspace's
 * whatsapp_connection row.
 */
export class BaileysManager {
  private socket: WASocket | null = null;
  private lockClient: Client | null = null;
  private stopped = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private qrExpiryTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private commandVersion = "-1";
  private intentionalClose = false;
  private connected = false;
  private opening = false;
  private sendTail: Promise<unknown> = Promise.resolve();
  private credsSaveTail: Promise<void> = Promise.resolve();
  private readonly logger: pino.Logger;

  private label = "";

  constructor(
    private readonly workspaceId: string,
    private readonly numberId: string,
    /** Spacing and typing waits; tests inject a no-op. */
    private readonly wait: (ms: number) => Promise<unknown> = sleep,
    /** The send decision's clock; tests inject a fixed time (no dependence on the real time of day). */
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.logger = pino({
      level: process.env.NODE_ENV === "production" ? "warn" : "info",
      redact: BAILEYS_LOG_REDACTION,
    }).child({ workspaceId, numberId });
  }

  get id() {
    return this.numberId;
  }

  /** True once stopped, including after losing the session lock; the registry then replaces this manager. */
  get isStopped() {
    return this.stopped;
  }

  async start() {
    // The session lock lives on its own connection, outside the shared pool,
    // so N numbers never pin N pooled connections.
    const client = new Client({ ...sessionConnectionOptions, application_name: WA_LOCK_APPLICATION_NAME });
    client.on("error", (error) => this.onLockConnectionLost(client, error));
    client.on("end", () => this.onLockConnectionLost(client));
    try {
      await client.connect();
      // Salt 1 keeps this "one worker owns this number's WhatsApp session"
      // lock in a separate namespace from the per-(number, phone) lock
      // (salt 0) — both hash an arbitrary string into a bigint via
      // hashtextextended, so two different salts guarantee they can never
      // collide. E4a: keyed by the number id (one lock per number).
      const lock = await client.query<{ locked: boolean }>(`select pg_try_advisory_lock(hashtextextended($1, 1)) as locked`, [
        this.numberId,
      ]);
      if (!lock.rows[0]?.locked) {
        throw new Error(`Another automation worker already owns this WhatsApp number's session (number ${this.numberId}).`);
      }
    } catch (error) {
      this.stopped = true;
      await client.end().catch(() => undefined);
      throw error;
    }
    this.lockClient = client;
    try {
      await this.syncControl();
    } catch (error) {
      // Release the lock so the registry's retry can take it again.
      await this.stop();
      throw error;
    }
    this.heartbeatTimer = setInterval(() => {
      void this.syncControl().catch((error) => this.logger.error({ err: error }, "WhatsApp control sync failed"));
    }, 10_000);
  }

  /**
   * Fail safe: once the lock connection errors or ends, another worker may
   * take the lock, so this manager must stop its socket and stop sending
   * immediately. The registry starts a replacement.
   */
  private onLockConnectionLost(client: Client, error?: Error) {
    if (this.stopped || this.lockClient !== client) return;
    this.logger.error({ err: error ?? "connection ended" }, "Session lock connection lost; stopping this number's WhatsApp manager");
    void this.stop();
  }

  async stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.qrExpiryTimer) clearTimeout(this.qrExpiryTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.intentionalClose = true;
    this.socket?.end(new Error("Worker shutting down"));
    this.socket = null;
    this.connected = false;
    const client = this.lockClient;
    this.lockClient = null;
    if (client) {
      await client.query(`select pg_advisory_unlock(hashtextextended($1, 1))`, [this.numberId]).catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }

  async syncControl() {
    const result = await pool.query<ConnectionControl>(CONTROL_SQL, [this.numberId]);
    const control = result.rows[0]!;
    this.label = control.label;
    await pool.query(`update public.whatsapp_numbers set worker_heartbeat_at = now() where id = $1`, [this.numberId]);
    const isNewCommand = control.command_version !== this.commandVersion;
    this.commandVersion = control.command_version;
    if (control.desired_state === "disconnected") {
      if (this.socket || isNewCommand) await this.logout();
      return;
    }
    if (control.desired_state === "restart" && isNewCommand) {
      await pool.query(`update public.whatsapp_numbers set desired_state = 'connected', status = 'connecting' where id = $1`, [this.numberId]);
      await this.closeSocket("Administrator requested restart");
      await this.openSocket();
      return;
    }
    if (!this.socket && !this.reconnectTimer) await this.openSocket();
  }

  private async openSocket() {
    if (this.socket || this.opening) return;
    this.opening = true;
    try {
      await this.openSocketUnguarded();
    } finally {
      this.opening = false;
    }
  }

  private async openSocketUnguarded() {
    this.intentionalClose = false;
    const connecting = await pool.query<{ paired_at: Date | null }>(
      `update public.whatsapp_numbers set status = 'connecting', last_error = null where id = $1 returning paired_at`,
      [this.numberId],
    );
    const { state, saveCreds } = await loadBaileysAuthState(this.numberId, this.workspaceId);
    if (this.stopped) return; // stopped (e.g. lock lost) while loading auth state
    const pairedBeforeE1 = Boolean(state.creds.me) && !connecting.rows[0]?.paired_at;
    const socket = makeWASocket({
      // B6: key writes go straight to the DB store; the cache only saves reads.
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.logger) },
      logger: this.logger,
      browser: pairedBeforeE1 ? LEGACY_BROWSER : PAIRING_BROWSER,
      msgRetryCounterCache: retryCounterCache(this.numberId),
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid) =>
        jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter"),
      getMessage: async (key) => {
        // By message id alone (unique): a retry request may name the chat by the JID
        // WhatsApp normalised or by its LID, not the PN JID we stored (B2).
        if (!key.id) return undefined;
        const result = await pool.query<{
          payload_ciphertext: Buffer;
          payload_iv: Buffer;
          payload_tag: Buffer;
          key_version: number;
        }>(
          `select payload_ciphertext, payload_iv, payload_tag, key_version
             from public.whatsapp_outbound_messages
            where workspace_id = $1 and message_id = $2 and payload_ciphertext is not null`,
          [this.workspaceId, key.id],
        );
        const row = result.rows[0];
        if (!row) return undefined;
        const plaintext = decryptBytes(
          { ciphertext: row.payload_ciphertext, iv: row.payload_iv, tag: row.payload_tag, keyVersion: row.key_version },
          `whatsapp:outbound:${key.id}`,
        ).toString("utf8");
        return proto.Message.fromObject(JSON.parse(plaintext));
      },
    });
    this.socket = socket;
    socket.ev.on("creds.update", (update) => {
      if (this.socket !== socket) return;
      Object.assign(state.creds, update);
      this.credsSaveTail = this.credsSaveTail
        .then(() => saveCreds())
        .catch((error) => this.logger.error({ err: error }, "Failed to persist WhatsApp credentials"));
    });
    socket.ev.on("connection.update", (update) => void this.handleConnectionUpdate(socket, update));
    socket.ev.on("messages.upsert", (event) => {
      if (this.socket !== socket) return;
      void processInboundUpsert(this.workspaceId, event, this.numberId).catch((error) => this.logger.error({ err: error }, "Inbound WhatsApp processing failed"));
    });
  }

  private async handleConnectionUpdate(source: WASocket, update: Partial<ConnectionState>) {
    if (this.socket !== source) return;
    if (update.qr) await this.storeQr(update.qr);
    // A QR scan just paired this number: warm-up (rule 3) counts from now.
    if (update.isNewLogin) await pool.query(`update public.whatsapp_numbers set paired_at = now() where id = $1`, [this.numberId]);
    if (update.reachoutTimeLock !== undefined) {
      await pool.query(`update public.whatsapp_numbers set reachout_lock = $1 where id = $2`, [jsonSafe(update.reachoutTimeLock), this.numberId]);
    }
    if (update.connection === "open") {
      this.connected = true;
      this.reconnectAttempt = 0;
      const user = this.socket?.user;
      await pool.query(
        `update public.whatsapp_numbers
            set status = 'connected', connected_jid = $1, connected_phone = $2, display_name = $3,
                last_connected_at = now(), last_error = null,
                qr_ciphertext = null, qr_iv = null, qr_tag = null, qr_expires_at = null
          where id = $4`,
        [user?.id ?? null, user?.id?.split("@", 1)[0]?.split(":", 1)[0] ?? null, user?.name ?? null, this.numberId],
      );
      const cap = await this.socket?.fetchNewChatMessageCap().catch(() => undefined);
      if (cap) await pool.query(`update public.whatsapp_numbers set new_chat_cap = $1 where id = $2`, [jsonSafe(cap), this.numberId]);
      return;
    }
    if (update.connection !== "close") return;
    this.connected = false;
    this.socket = null;
    const code = disconnectCode(update);
    const message = update.lastDisconnect?.error?.message ?? "WhatsApp connection closed.";
    if (this.intentionalClose) return;
    const action = disconnectAction(code);
    if (action === "reconnect" || action === "reconnect_now") {
      await pool.query(
        `update public.whatsapp_numbers set status = 'reconnecting', last_error = $1, last_disconnected_at = now() where id = $2`,
        [message, this.numberId],
      );
      // A dropped connection counts toward the reconnect-storm signal; 515 right after pairing doesn't.
      if (action === "reconnect") await this.recordReconnectFailure(`${code ?? "unknown"}: ${message}`);
      this.scheduleReconnect(action === "reconnect_now" ? 0 : undefined);
      return;
    }
    // Never reconnect. desired_state 'disconnected' also makes the registry stop this manager.
    const stop = STOP_ON_DISCONNECT[action];
    if (stop.clearAuth) await clearBaileysAuthState(this.numberId);
    await pool.query(
      `update public.whatsapp_numbers
          set status = $1, desired_state = 'disconnected', last_error = $2, last_disconnected_at = now(),
              qr_ciphertext = null, qr_iv = null, qr_tag = null, qr_expires_at = null${stop.clearAuth ? ", paired_at = null" : ""}
        where id = $3`,
      [stop.clearAuth ? "reauth_required" : "error", message, this.numberId],
    );
    await withTransaction(async (db) => {
      await recordSafetyEvent(db, this.workspaceId, this.numberId, "disconnected", `${code ?? "unknown"}: ${message}`.slice(0, 500));
      const paused = stop.pause && (await autoPause(db, this.workspaceId, this.numberId, stop.reason));
      if (!paused) await notifyAdmins(db, this.workspaceId, `WhatsApp number ${this.label} disconnected`, stop.reason);
    }).catch((error) => this.logger.error({ err: error }, "Failed to record a WhatsApp disconnect"));
  }

  private scheduleReconnect(forcedDelay?: number) {
    if (this.reconnectTimer) return;
    const delay = forcedDelay ?? reconnectDelayMs(this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket().catch(async (error) => {
        this.logger.error({ err: error }, "WhatsApp reconnect failed");
        await this.recordReconnectFailure(error instanceof Error ? error.message : "reconnect failed");
        this.scheduleReconnect();
      });
    }, delay);
  }

  /** Rule 7 / B4: ≥ 5 dropped connections or failed reconnects in 30 min pause sending (a storm is itself a risk signal). */
  private async recordReconnectFailure(detail: string) {
    await withTransaction(async (db) => {
      await recordSafetyEvent(db, this.workspaceId, this.numberId, "reconnect_failed", detail.slice(0, 500));
      await this.checkAutoPause(db);
    }).catch((error) => this.logger.error({ err: error }, "Failed to record a WhatsApp reconnect failure"));
  }

  private async storeQr(qr: string) {
    // Not workspace-namespaced — see baileys-auth.store.ts's comment: AAD
    // must stay a fixed string so it matches whatever pre-existing rows
    // were encrypted under before per-workspace scoping shipped.
    const encrypted = encryptBytes(Buffer.from(qr, "utf8"), "whatsapp:pairing-qr");
    const expiresAt = new Date(Date.now() + 90_000);
    await pool.query(
      `update public.whatsapp_numbers
          set status = 'qr_ready', qr_ciphertext = $1, qr_iv = $2, qr_tag = $3, qr_key_version = $4, qr_expires_at = $5
        where id = $6`,
      [encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.keyVersion, expiresAt.toISOString(), this.numberId],
    );
    if (this.qrExpiryTimer) clearTimeout(this.qrExpiryTimer);
    this.qrExpiryTimer = setTimeout(() => {
      void pool.query(
        `update public.whatsapp_numbers
            set qr_ciphertext = null, qr_iv = null, qr_tag = null, qr_expires_at = null,
                status = case when status = 'qr_ready' then 'connecting' else status end
          where id = $1 and qr_expires_at <= now()`,
        [this.numberId],
      );
    }, 91_000);
  }

  private async closeSocket(reason: string) {
    this.intentionalClose = true;
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    socket?.end(new Error(reason));
    this.intentionalClose = false;
  }

  private async logout() {
    this.intentionalClose = true;
    if (this.socket) await this.socket.logout().catch(() => undefined);
    this.socket = null;
    this.connected = false;
    await clearBaileysAuthState(this.numberId);
    await pool.query(
      `update public.whatsapp_numbers
          set status = 'disconnected', connected_jid = null, connected_phone = null, display_name = null,
              last_error = null, reachout_lock = null, new_chat_cap = null, last_disconnected_at = now(), paired_at = null,
              qr_ciphertext = null, qr_iv = null, qr_tag = null, qr_expires_at = null
        where id = $1`,
      [this.numberId],
    );
    this.intentionalClose = false;
  }

  sendAction(input: {
    source: WhatsAppSendSource;
    phoneE164: string;
    body: string;
    attachment?: WhatsAppAttachment;
    /** E2h rule 2: an AI text that promises the attachment is cancelled, not sent, when the file can't go. */
    textMentionsAttachment?: boolean | undefined;
  }): Promise<{ providerMessageId: string; attachmentProblem?: string }> {
    const task = this.sendTail.then(() => this.performSend(input));
    this.sendTail = task.catch(() => undefined);
    return task;
  }

  private async performSend(input: { source: WhatsAppSendSource; phoneE164: string; body: string; attachment?: WhatsAppAttachment; textMentionsAttachment?: boolean | undefined }) {
    if (!this.socket || !this.connected) throw new ProviderDeferredError("WhatsApp is disconnected or awaiting QR pairing.");
    const jid = phoneE164ToJid(input.phoneE164);
    const column = sourceColumn(input.source);
    const sourceId = input.source.id;
    const proposedMessageId = generateMessageIDV2(this.socket.user?.id);
    const prepared = await withTransaction(async (db) => {
      await db.query(
        `insert into public.whatsapp_outbound_messages (workspace_id, ${column}, message_id, remote_jid, whatsapp_number_id)
         values ($1,$2,$3,$4,$5)
         on conflict (${column}) do update set whatsapp_number_id = excluded.whatsapp_number_id
           where whatsapp_outbound_messages.status = 'prepared'`,
        [this.workspaceId, sourceId, proposedMessageId, jid, this.numberId],
      );
      const result = await db.query<OutboundRow>(
        `select message_id, remote_jid, status from public.whatsapp_outbound_messages where ${column} = $1`,
        [sourceId],
      );
      const row = result.rows[0]!;
      // Text-only placeholder even when this send carries an attachment: if a
      // retry-receipt request lands in the narrow window between this claim
      // and the real send below, it would be served this placeholder instead
      // of the actual media message. Accepted minor edge case, not fixed here.
      const retryPayload = proto.Message.toObject(proto.Message.fromObject({ conversation: input.body }));
      const encrypted = encryptBytes(
        Buffer.from(JSON.stringify(retryPayload), "utf8"),
        `whatsapp:outbound:${row.message_id}`,
      );
      await db.query(
        `update public.whatsapp_outbound_messages
            set payload_ciphertext = $2, payload_iv = $3, payload_tag = $4, key_version = $5, updated_at = now()
          where ${column} = $1 and payload_ciphertext is null`,
        [sourceId, encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.keyVersion],
      );
      return row;
    });
    if (prepared.remote_jid !== jid) {
      throw new PermanentProviderError("The lead phone changed after this WhatsApp action was prepared; the action was not redirected.");
    }
    // Claim the send: connection, restrictions, eligibility, idempotency and the
    // E1 safety decision (pause, window, caps, first-message rules, spacing) — all
    // inside a short transaction that releases its row locks before any wait. The
    // transaction returns its outcome and errors are thrown after commit, so its
    // writes (auto-pause, a not-registered number) are kept.
    const claim = await withTransaction(async (db): Promise<Claim> => {
      // E4a rule 7: per-(number, phone) lock, shared with this number's inbound processing.
      await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [numberPhoneLockKey(this.numberId, input.phoneE164)]);
      const state = await db.query<ConnectionControl>(`${CONTROL_SQL} for update of n`, [this.numberId]);
      const control = state.rows[0]!;
      if (control.status !== "connected" || !this.socket || !this.connected) return { kind: "defer", reason: "WhatsApp is not connected.", retryAfterMs: 60_000 };
      const masterOff = !control.outbound_enabled;
      let paused = !control.enabled || masterOff;
      if (!paused) {
        const [liveReachout, liveCap] = await Promise.all([
          this.socket.fetchAccountReachoutTimelock().catch(() => control.reachout_lock),
          this.socket.fetchNewChatMessageCap().catch(() => control.new_chat_cap),
        ]);
        await db.query(`update public.whatsapp_numbers set reachout_lock = $1, new_chat_cap = $2 where id = $3`, [
          jsonSafe(liveReachout),
          jsonSafe(liveCap),
          this.numberId,
        ]);
        if (isOutboundRestricted(liveReachout, liveCap)) {
          await recordSafetyEvent(db, this.workspaceId, this.numberId, "restricted", "WhatsApp applied a reach-out or new-chat restriction.");
          await autoPause(db, this.workspaceId, this.numberId, RESTRICTED_REASON);
          paused = true;
        }
      }
      let eligiblePhone: string | null;
      let firstInboundWindow = false;
      if (input.source.type === "agent") {
        // E2 rule 5: the AI send's re-check, under the decision + lead row locks, right before the send.
        const check = await agentSendRecheck(db, input.source.id, "whatsapp");
        if ("cancel" in check) return { kind: "cancel", reason: check.cancel };
        if ("defer" in check) return { kind: "defer", reason: check.reason, retryAfterMs: Math.max(check.defer.getTime() - Date.now(), 1_000) };
        eligiblePhone = check.phoneE164 ?? null;
        firstInboundWindow = check.freshInbound === true;
        if (eligiblePhone !== input.phoneE164) return { kind: "cancel", reason: "The contact's phone number changed after this message was written." };
      } else {
        eligiblePhone = await loadSourceEligibility(db, this.workspaceId, input.source);
      }
      if (eligiblePhone !== input.phoneE164) return { kind: "permanent", reason: "The lead is no longer eligible for this WhatsApp action." };
      // E4a rules 3/6: the lead's sticky number (row locked by the eligibility check). None yet → this
      // number becomes it; moved by an admin since the send picked this number → retry on the new one.
      const leadId = await resolveLeadIdForSource(db, input.source);
      if (leadId) {
        const sticky = await db.query<{ whatsapp_number_id: string | null }>(`select whatsapp_number_id from public.leads where id = $1 for update`, [leadId]);
        const current = sticky.rows[0]?.whatsapp_number_id;
        if (sticky.rows[0] && !current) await db.query(`update public.leads set whatsapp_number_id = $2 where id = $1`, [leadId, this.numberId]);
        else if (sticky.rows[0] && current !== this.numberId) {
          return { kind: "defer", reason: "The contact's WhatsApp number changed; the send moves to it.", retryAfterMs: 1_000 };
        }
      }
      const existing = await db.query<OutboundRow>(
        `select message_id, remote_jid, status from public.whatsapp_outbound_messages where ${column} = $1`,
        [sourceId],
      );
      if (existing.rows[0]?.status === "sent") return { kind: "alreadySent", messageId: existing.rows[0].message_id };
      const messageId = existing.rows[0]?.message_id ?? prepared.message_id;

      const stats = await loadSendStats(db, this.workspaceId, this.numberId, jid, input.phoneE164, control.resumed_at);
      const signal = paused ? null : shouldAutoPause(stats);
      if (signal && (await autoPause(db, this.workspaceId, this.numberId, signal))) paused = true;
      const now = this.clock();
      const decision = decideSend({
        source: safetySourceOf(input.source),
        now,
        window: { days: control.send_window_days, start: control.send_window_start, end: control.send_window_end },
        dailyCap: control.daily_cap,
        warmupDay: warmupDayFor(control.paired_at, now),
        sentToday: stats.sentToday,
        maxNewChatsPerDay: control.max_new_chats_per_day,
        newChatsToday: stats.newChatsToday,
        isFirstMessage: stats.isFirstMessage,
        isNewChat: stats.isNewChat,
        text: input.body,
        paused,
        nextSendAt: control.next_send_at,
        firstInboundWindow,
      });
      if ("defer" in decision) {
        const pausedReason = signal ?? (masterOff ? MASTER_OFF_REASON : control.paused_reason);
        const reason = paused && pausedReason ? `WhatsApp sending is paused: ${pausedReason}` : decision.reason;
        return { kind: "defer", reason, retryAfterMs: Math.max(decision.defer.getTime() - now.getTime(), 1_000) };
      }
      if ("block" in decision) {
        await db.query(`update public.whatsapp_outbound_messages set status = 'failed', last_error = $2 where ${column} = $1`, [sourceId, decision.block]);
        return { kind: "permanent", reason: decision.block };
      }

      const registered = (await this.socket.onWhatsApp(input.phoneE164.slice(1)))?.find((entry) => entry.exists);
      if (!registered) {
        await db.query(
          `update public.whatsapp_outbound_messages set status = 'failed', last_error = 'Recipient is not on WhatsApp' where ${column} = $1`,
          [sourceId],
        );
        const leadId = await resolveLeadIdForSource(db, input.source);
        if (leadId) {
          await db.query(
            `insert into public.lead_contact_channels (lead_id, channel, status, reason, updated_by_name)
             values ($1, 'whatsapp', 'invalid', 'Number is not registered on WhatsApp', 'Automation')
             on conflict (lead_id, channel) do update
               set status = 'invalid', reason = excluded.reason, updated_at = now(), updated_by = null, updated_by_name = 'Automation'`,
            [leadId],
          );
        }
        return { kind: "permanent", reason: "Recipient is not registered on WhatsApp." };
      }
      return {
        kind: "send",
        messageId,
        sendJid: registered.jid || jid,
        text: decision.text,
        typingMs: decision.typingMs,
        spacingMs: decision.spacingMs,
        newChat: stats.isNewChat,
        minDelaySeconds: control.min_delay_seconds,
        maxDelaySeconds: control.max_delay_seconds,
      };
    });
    if (claim.kind === "alreadySent") return { providerMessageId: claim.messageId };
    if (claim.kind === "defer") throw new ProviderDeferredError(claim.reason, claim.retryAfterMs);
    if (claim.kind === "permanent") throw new PermanentProviderError(claim.reason);
    if (claim.kind === "cancel") throw new SendCancelledError(claim.reason);
    if (claim.spacingMs > 0) await this.wait(claim.spacingMs);

    // Re-check the emergency switch and live connection state after the spacing
    // sleep: the row lock above was released before sleeping, so a disable made
    // during the wait must still stop this send from going out.
    const recheck = await pool.query<{ enabled: boolean; status: string }>(
      `select n.enabled and c.outbound_enabled as enabled, n.status
         from public.whatsapp_numbers n join public.whatsapp_connection c on c.workspace_id = n.workspace_id
        where n.id = $1`,
      [this.numberId],
    );
    if (!recheck.rows[0]?.enabled) throw new ProviderDeferredError("WhatsApp outbound is disabled by the emergency switch.");
    if (recheck.rows[0].status !== "connected" || !this.socket || !this.connected) {
      throw new ProviderDeferredError("WhatsApp is not connected.");
    }

    let messageContent: AnyMessageContent = { text: claim.text };
    let attachmentProblem: string | undefined;
    if (input.attachment) {
      const isAgent = input.source.type === "agent";
      const { data, error } = await supabaseAdmin.storage
        .from(input.attachment.bucket)
        .download(input.attachment.storagePath);
      // E2g rule 6 + E2h rule 3: an AI message whose asset file is gone or too big goes out as text only (the caller records it).
      if (error && isAgent && isMissingStorageObject(error)) attachmentProblem = ASSET_MISSING_REASON;
      else if (error || !data) throw new Error(`Failed to download WhatsApp attachment: ${error?.message ?? "no data"}`);
      else {
        const buffer = Buffer.from(await data.arrayBuffer());
        if (isAgent && buffer.length > MAX_ATTACHMENT_BYTES) attachmentProblem = ASSET_TOO_BIG_REASON;
        else {
          messageContent = input.attachment.mimeType.startsWith("image/")
            ? { image: buffer, caption: claim.text }
            : { document: buffer, fileName: input.attachment.fileName, mimetype: input.attachment.mimeType, caption: claim.text };
        }
      }
      if (attachmentProblem && input.textMentionsAttachment) throw new SendCancelledError(ATTACHMENT_MISSING, attachmentProblem);
    }

    // The socket can still go away after the recheck (e.g. the session lock
    // connection drops and stop() nulls it) or during typing. Nothing went out, so defer.
    if (!this.socket || !this.connected) throw new ProviderDeferredError("WhatsApp disconnected before the message could be sent.");
    await this.showTyping(this.socket, claim.sendJid, claim.typingMs);
    const socket = this.socket as WASocket | null;
    if (!socket || !this.connected) throw new ProviderDeferredError("WhatsApp disconnected before the message could be sent.");
    // No DB transaction is held across the network send.
    const sent = await socket.sendMessage(claim.sendJid, messageContent, { messageId: claim.messageId }).catch(async (error: unknown) => {
      if ((error as { output?: { statusCode?: number } }).output?.statusCode === DisconnectReason.connectionClosed) {
        throw new ProviderDeferredError("WhatsApp disconnected before the message could be sent.");
      }
      await this.recordSendFailure(error).catch((e: unknown) => this.logger.error({ err: e }, "Failed to record a WhatsApp send failure"));
      throw error;
    });
    if (!sent?.message) throw new Error("Baileys returned no message payload.");
    const payload = proto.Message.toObject(proto.Message.fromObject(sent.message));
    const encrypted = encryptBytes(Buffer.from(JSON.stringify(payload), "utf8"), `whatsapp:outbound:${claim.messageId}`);
    await withTransaction(async (db) => {
      const sentRow = await db.query<{ id: string }>(
        `update public.whatsapp_outbound_messages
            set status = 'sent', payload_ciphertext = $2, payload_iv = $3, payload_tag = $4,
                key_version = $5, sent_at = now(), last_error = null, updated_at = now(), new_chat = $6
          where ${column} = $1
          returning id`,
        [sourceId, encrypted.ciphertext, encrypted.iv, encrypted.tag, encrypted.keyVersion, claim.newChat],
      );
      // E3b-2b rule 14: the message really went out.
      if (sentRow.rows[0]) await recordWhatsAppFact(db, sentRow.rows[0].id);
      // Spacing: the next send of this number waits a fresh random min–max delay (45–120 s by default).
      await db.query(`update public.whatsapp_numbers set next_send_at = now() + make_interval(secs => $2) where id = $1`, [
        this.numberId,
        randomSpacingMs(claim.minDelaySeconds, claim.maxDelaySeconds) / 1_000,
      ]);
    });
    return { providerMessageId: claim.messageId, ...(attachmentProblem ? { attachmentProblem } : {}) };
  }

  /**
   * B1: "typing…" for `ms` (composing resent every ≤ 8 s), then paused, then the caller sends.
   * Never `available`: that would make WhatsApp treat us as an active desktop and mute the
   * paired phone's notifications. Presence errors never fail a send.
   */
  private async showTyping(socket: WASocket, jid: string, ms: number) {
    for (let left = ms; left > 0; left -= COMPOSING_REFRESH_MS) {
      await socket.sendPresenceUpdate("composing", jid).catch(() => undefined);
      await this.wait(Math.min(left, COMPOSING_REFRESH_MS));
    }
    await socket.sendPresenceUpdate("paused", jid).catch(() => undefined);
  }

  /** Rule 7: a failed send is a signal; 5 within 30 min pause this number. */
  private async recordSendFailure(error: unknown) {
    await withTransaction(async (db) => {
      await recordSafetyEvent(db, this.workspaceId, this.numberId, "send_failed", error instanceof Error ? error.message.slice(0, 500) : null);
      await this.checkAutoPause(db);
    });
  }

  /** Pauses when the counted signals (failures, reconnects, STOPs) cross a rule-7 limit. */
  private async checkAutoPause(db: Queryable) {
    const control = await db.query<{ enabled: boolean; resumed_at: Date | null }>(
      `select enabled, resumed_at from public.whatsapp_numbers where id = $1 for update`,
      [this.numberId],
    );
    if (!control.rows[0]?.enabled) return;
    const signal = shouldAutoPause(await loadSendStats(db, this.workspaceId, this.numberId, "", "", control.rows[0].resumed_at));
    if (signal) await autoPause(db, this.workspaceId, this.numberId, signal);
  }
}
