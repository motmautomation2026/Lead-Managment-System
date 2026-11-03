/**
 * D3: the worker reads each workspace's mailbox over IMAP (read-only: EXAMINE + BODY.PEEK,
 * never a flag, move, copy, delete or expunge), recognises bounces, auto-replies, unsubscribes
 * and replies, and applies their effects, one transaction per message. No DB client is held
 * during the IMAP session. A reply's text is stored only encrypted and never logged.
 */
import type { ParsedMail } from "mailparser";
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { escapeLike } from "../lists/listQuery.js";
import { encryptText } from "../security/encryption.js";
import { connectionTestMessage } from "../domain/emailSafety.js";
import {
  MAX_SOURCE_BYTES,
  candidateMessageIds,
  classifyInboundEmail,
  extractReplyText,
  fromAddressOf,
  parseInboundEmail,
  type Dsn,
  type InboundEmailKind,
  type OwnMailbox,
} from "../domain/emailInbound.js";
import { matchReplyKeyword } from "../domain/replyKeywords.js";
import { DEFAULT_EMAIL_REPLY_TASK_TITLE } from "../agent/replyClassification.js";
import type { AgentMode, AgentStatus } from "../agent/rules.js";
import { createImapReader, withTimeout, type ImapMessage, type ImapReaderFactory } from "../providers/email.provider.js";
import { imapOf, loadEmailConnection, recordEmailEvent } from "./emailConnection.service.js";
import { checkAutoPause } from "./emailOutbound.service.js";
import { emailReplyAad } from "./inboundReplies.service.js";
import { applyReplyEffects, applyReplyLabel } from "./replyLabels.service.js";
import { markReplyForDraft } from "./replyDrafts.service.js";
import { addTimelineEvent, SYSTEM_ACTOR } from "./timeline.service.js";
import { onAgentEvent } from "./agentEvents.service.js";
import { ensureReplyTask, stopAutomationForReply } from "./whatsapp-inbound.service.js";
import { notifyAdmins } from "./whatsappSafety.service.js";

export const MAX_MESSAGES_PER_POLL = 50;
/** The whole IMAP session (connect → fetch → logout) never holds the worker longer than this. */
const SESSION_TIMEOUT_MS = 120_000;
export const IMAP_LOGIN_REJECTED = "IMAP login rejected — check the IMAP username and password in Settings → Email.";
const AUTO_REPLY_TITLE = "Automatic email reply received (out of office or similar)";

export interface EmailInboundDeps {
  imap?: ImapReaderFactory;
  /** Default: EMAIL_IMAP_POLL_SECONDS (120). */
  pollSeconds?: number;
  now?: () => Date;
  /** Tests: only these workspaces. */
  workspaceIds?: string[];
}

interface ImapState {
  workspace_id: string;
  uidvalidity: string | null;
  last_uid: string | null;
  imap_saved_at: Date | null;
  last_success_at: Date | null;
  login_alerted_on: string | null;
}

export interface PollResult {
  workspaceId: string;
  outcome: "polled" | "no_login" | "error";
  processed: number;
  kinds: Partial<Record<InboundEmailKind | "duplicate", number>>;
}

// ---------------------------------------------------------------------------
// Worker tick

/** Polls at most one due workspace (one at a time, every `pollSeconds` each). */
export async function runEmailInbound(deps: EmailInboundDeps = {}): Promise<PollResult | null> {
  const scope = deps.workspaceIds ?? null;
  // Every active workspace with a saved IMAP host gets a state row; the first poll reads mail after imap_saved_at.
  await pool.query(
    `insert into public.email_imap_state (workspace_id, imap_saved_at)
     select c.workspace_id, coalesce(c.configured_at, now())
       from public.integration_connections c join public.workspaces w on w.id = c.workspace_id
      where c.id = 'email' and c.provider = 'smtp' and coalesce(c.settings->>'imapHost', '') <> '' and w.is_active
        and ($1::uuid[] is null or c.workspace_id = any($1::uuid[]))
     on conflict (workspace_id) do nothing`,
    [scope],
  );
  const claimed = await pool.query<ImapState>(
    `update public.email_imap_state s
        set next_poll_at = now() + $2 * interval '1 second', last_poll_at = now()
      where s.workspace_id = (
        select x.workspace_id from public.email_imap_state x
          join public.integration_connections c on c.workspace_id = x.workspace_id and c.id = 'email' and c.provider = 'smtp'
          join public.workspaces w on w.id = x.workspace_id and w.is_active
         where x.next_poll_at <= now() and ($1::uuid[] is null or x.workspace_id = any($1::uuid[]))
         order by x.next_poll_at
         limit 1
         for update of x skip locked)
      returning s.workspace_id, s.uidvalidity::text, s.last_uid::text, s.imap_saved_at, s.last_success_at, s.login_alerted_on::text`,
    [scope, deps.pollSeconds ?? 120],
  );
  const state = claimed.rows[0];
  return state ? pollWorkspace(state, deps) : null;
}

// ---------------------------------------------------------------------------
// One workspace

interface MailboxRead {
  uidValidity: string;
  messages: ImapMessage[];
  /** last_uid after processing everything read (more left → the highest read). */
  nextLastUid: number;
}

async function readMailbox(factory: ImapReaderFactory, imap: NonNullable<ReturnType<typeof imapOf>>, state: ImapState, now: Date): Promise<MailboxRead> {
  const client = factory(imap);
  try {
    return await withTimeout(
      (async () => {
        await client.connect();
        const box = await client.mailboxOpen(imap.folder, { readOnly: true });
        const uidValidity = String(box.uidValidity);
        const fresh = state.uidvalidity === null || state.uidvalidity !== uidValidity;
        const lastUid = fresh ? 0 : Number(state.last_uid ?? 0);
        let uids: number[];
        if (fresh) {
          // First poll: mail after the login was saved; after a UIDVALIDITY change: after the last good poll.
          const since = (state.uidvalidity === null ? state.imap_saved_at : (state.last_success_at ?? state.imap_saved_at)) ?? now;
          const found = (await client.search({ since: new Date(since.getTime() - 86_400_000) }, { uid: true })) || [];
          // SEARCH SINCE is by date only: keep the messages that arrived after `since` exactly.
          const arrived = new Map<number, number>();
          if (found.length) {
            for await (const m of client.fetch(found.join(","), { uid: true, internalDate: true }, { uid: true })) {
              arrived.set(m.uid, m.internalDate ? new Date(m.internalDate).getTime() : 0);
            }
          }
          uids = found.filter((uid) => (arrived.get(uid) ?? 0) > since.getTime());
        } else {
          // "n:*" always returns the newest message, even below n.
          uids = ((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || []).filter((uid) => uid > lastUid);
        }
        uids.sort((a, b) => a - b);
        const batch = uids.slice(0, MAX_MESSAGES_PER_POLL);
        const messages: ImapMessage[] = [];
        if (batch.length) {
          for await (const m of client.fetch(batch.join(","), { uid: true, internalDate: true, source: { start: 0, maxLength: MAX_SOURCE_BYTES } }, { uid: true })) {
            messages.push(m);
          }
        }
        await client.logout();
        const newest = Math.max(lastUid, (box.uidNext ?? 1) - 1, ...batch);
        return { uidValidity, messages: messages.sort((a, b) => a.uid - b.uid), nextLastUid: uids.length > batch.length ? batch[batch.length - 1]! : newest };
      })(),
      SESSION_TIMEOUT_MS,
    );
  } finally {
    client.close();
  }
}

const isLoginRejected = (err: unknown) => {
  const e = (err ?? {}) as { authenticationFailed?: boolean; serverResponseCode?: string; responseText?: string; message?: string };
  return Boolean(e.authenticationFailed) || e.serverResponseCode === "AUTHENTICATIONFAILED" || /AUTHENTICATIONFAILED|invalid credentials|authentication failed/i.test(`${e.responseText ?? ""} ${e.message ?? ""}`);
};

async function pollWorkspace(state: ImapState, deps: EmailInboundDeps): Promise<PollResult> {
  const workspaceId = state.workspace_id;
  const result: PollResult = { workspaceId, outcome: "polled", processed: 0, kinds: {} };
  const { row, secrets } = await loadEmailConnection(pool, workspaceId);
  const imap = imapOf(row, secrets);
  if (!imap) return { ...result, outcome: "no_login" };
  const fromAddress = row.settings.senderAddress ?? "";
  const own: OwnMailbox = { fromAddress, replyTo: row.settings.replyTo || fromAddress };
  const now = deps.now?.() ?? new Date();

  let read: MailboxRead;
  try {
    read = await readMailbox(deps.imap ?? createImapReader, imap, state, now);
  } catch (err) {
    const rejected = isLoginRejected(err);
    const message = rejected ? IMAP_LOGIN_REJECTED : connectionTestMessage(err, imap);
    // Codes only in logs; the plain-English message (no secrets) goes to Settings.
    console.warn(`[email-inbound] workspace ${workspaceId}: IMAP read failed (${(err as { code?: string })?.code ?? (rejected ? "login rejected" : "error")}).`);
    await withTransaction(async (db) => {
      await db.query(`update public.email_imap_state set last_error = $2 where workspace_id = $1`, [workspaceId, message]);
      // Sending is never paused for this; admins hear about it once per IST day.
      if (rejected) {
        const alerted = await db.query(
          `update public.email_imap_state set login_alerted_on = (now() at time zone 'Asia/Kolkata')::date
            where workspace_id = $1 and login_alerted_on is distinct from (now() at time zone 'Asia/Kolkata')::date returning 1`,
          [workspaceId],
        );
        if (alerted.rowCount) await notifyAdmins(db, workspaceId, "Email replies can't be read", `${IMAP_LOGIN_REJECTED} Email sending is not affected.`);
      }
    });
    return { ...result, outcome: "error" };
  }

  let lastUid = read.nextLastUid;
  let error: string | null = null;
  for (const message of read.messages) {
    try {
      const kind = await processMessage(workspaceId, read.uidValidity, message, own, now);
      result.kinds[kind] = (result.kinds[kind] ?? 0) + 1;
      result.processed += 1;
    } catch (err) {
      // Retried next poll from this message (dedupe makes that safe). Codes only: never message content.
      console.error(`[email-inbound] workspace ${workspaceId}: message uid ${message.uid} failed (${(err as { code?: string })?.code ?? "error"}).`);
      error = "A message couldn't be processed; it will be retried on the next check.";
      lastUid = message.uid - 1;
      break;
    }
  }
  await pool.query(
    `update public.email_imap_state
        set uidvalidity = $2::bigint, last_uid = $3::bigint, last_error = $4,
            last_success_at = case when $4::text is null then now() else last_success_at end
      where workspace_id = $1`,
    [workspaceId, read.uidValidity, String(lastUid), error],
  );
  return result;
}

// ---------------------------------------------------------------------------
// One message (one transaction)

interface LeadRef {
  id: string;
  owner_id: string | null;
  owner_name: string | null;
  agent_status: AgentStatus;
}

interface Match {
  status: "matched" | "unmatched" | "ambiguous";
  method: "in_reply_to" | "references" | "sender" | "original_message" | "recipient" | null;
  leadId: string | null;
  outboundId: string | null;
}

const NO_MATCH: Match = { status: "unmatched", method: null, leadId: null, outboundId: null };

/** The contact if it still exists; a merged contact → its target (followed a few hops). */
async function liveLead(db: Queryable, workspaceId: string, leadId: string): Promise<string | null> {
  let id: string | null = leadId;
  for (let hop = 0; id && hop < 5; hop++) {
    const row: { merged_into_lead_id: string | null } | undefined = (
      await db.query<{ merged_into_lead_id: string | null }>(`select merged_into_lead_id from public.leads where id = $1 and workspace_id = $2`, [id, workspaceId])
    ).rows[0];
    if (!row) return null;
    if (!row.merged_into_lead_id) return id;
    id = row.merged_into_lead_id;
  }
  return null;
}

/** Exactly one non-merged contact with this email in the workspace. */
async function matchByAddress(db: Queryable, workspaceId: string, address: string | null, method: "sender" | "recipient"): Promise<Match> {
  if (!address) return NO_MATCH;
  const rows = await db.query<{ id: string }>(
    `select id from public.leads where workspace_id = $1 and merged_into_lead_id is null and email ilike $2 limit 2`,
    [workspaceId, escapeLike(address)],
  );
  if (rows.rows.length === 1) return { status: "matched", method, leadId: rows.rows[0]!.id, outboundId: null };
  return rows.rows.length > 1 ? { ...NO_MATCH, status: "ambiguous" } : NO_MATCH;
}

async function outboundByMessageId(db: Queryable, workspaceId: string, ids: string[]) {
  if (!ids.length) return [];
  return (
    await db.query<{ id: string; message_id: string; lead_id: string | null }>(
      `select id, message_id, lead_id from public.email_outbound_messages where workspace_id = $1 and message_id = any($2::text[])`,
      [workspaceId, ids],
    )
  ).rows;
}

/** Rule 4: In-Reply-To, then References → our email → its contact; else the sender's address. */
async function matchReply(db: Queryable, workspaceId: string, parsed: ParsedMail): Promise<Match> {
  const candidates = candidateMessageIds(parsed);
  const ours = await outboundByMessageId(db, workspaceId, candidates.map((c) => c.id));
  for (const candidate of candidates) {
    const outbound = ours.find((o) => o.message_id === candidate.id);
    const leadId = outbound?.lead_id ? await liveLead(db, workspaceId, outbound.lead_id) : null;
    if (outbound && leadId) return { status: "matched", method: candidate.method, leadId, outboundId: outbound.id };
  }
  return matchByAddress(db, workspaceId, fromAddressOf(parsed), "sender");
}

/** A bounce: the original Message-ID → our email; else Final-Recipient → our latest email to it, else a contact. */
async function matchBounce(db: Queryable, workspaceId: string, dsn: Dsn): Promise<Match> {
  if (dsn.originalMessageId) {
    const outbound = (await outboundByMessageId(db, workspaceId, [dsn.originalMessageId]))[0];
    if (outbound) {
      const leadId = outbound.lead_id ? await liveLead(db, workspaceId, outbound.lead_id) : null;
      return { status: "matched", method: "original_message", leadId, outboundId: outbound.id };
    }
  }
  if (!dsn.recipient) return NO_MATCH;
  const latest = (
    await db.query<{ id: string; lead_id: string | null }>(
      `select id, lead_id from public.email_outbound_messages
        where workspace_id = $1 and lower(to_address) = $2 and status = 'sent' and not dry_run
        order by sent_at desc limit 1`,
      [workspaceId, dsn.recipient],
    )
  ).rows[0];
  if (latest) {
    const leadId = latest.lead_id ? await liveLead(db, workspaceId, latest.lead_id) : null;
    return { status: "matched", method: "recipient", leadId, outboundId: latest.id };
  }
  return matchByAddress(db, workspaceId, dsn.recipient, "recipient");
}

/** Plain-English bounce reason for the timeline. */
function bounceReason(status: string): string {
  if (status.startsWith("5.1.")) return "address doesn't exist";
  if (status.startsWith("5.2.")) return "mailbox full or disabled";
  if (status.startsWith("5.7.")) return "blocked by the recipient's server";
  return `status ${status}`;
}

async function processMessage(workspaceId: string, uidValidity: string, message: ImapMessage, own: OwnMailbox, now: Date): Promise<InboundEmailKind | "duplicate"> {
  let parsed: ParsedMail | null = null;
  try {
    parsed = message.source ? await parseInboundEmail(message.source) : null;
  } catch {
    parsed = null; // Unparseable: recorded as ignored.
  }
  const { kind, dsn } = parsed ? classifyInboundEmail(parsed, own) : { kind: "ignored" as const, dsn: undefined };
  const messageIdHeader = parsed?.messageId?.trim().slice(0, 998) || null;
  const receivedAt = message.internalDate ? new Date(message.internalDate) : (parsed?.date ?? now);

  return withTransaction(async (db) => {
    const inserted = await db.query<{ id: string }>(
      `insert into public.email_inbound_events (workspace_id, message_id_header, uidvalidity, uid, from_address, received_at, kind)
       values ($1, $2, $3::bigint, $4, $5, $6, $7)
       on conflict do nothing
       returning id`,
      [workspaceId, messageIdHeader, uidValidity, message.uid, parsed ? fromAddressOf(parsed) : null, receivedAt, kind],
    );
    const eventId = inserted.rows[0]?.id;
    if (!eventId) return "duplicate";
    if (!parsed || kind === "ignored") return kind;

    const match = kind === "bounce" || kind === "bounce_temporary" ? await matchBounce(db, workspaceId, dsn!) : await matchReply(db, workspaceId, parsed);
    await db.query(
      `update public.email_inbound_events
          set match_status = $2, match_method = $3, lead_id = $4, outbound_id = $5, bounce_status = $6, bounce_detail = $7
        where id = $1`,
      [eventId, match.status, match.method, match.leadId, match.outboundId, dsn?.status ?? null, dsn?.diagnostic ?? null],
    );
    if (match.status !== "matched") return kind;

    if (kind === "bounce") await applyBounce(db, workspaceId, eventId, dsn!, match);
    else if (kind === "auto_reply" && match.leadId) {
      await addTimelineEvent(db, { leadId: match.leadId, kind: "email", title: AUTO_REPLY_TITLE, metadata: { emailEventId: eventId }, ...SYSTEM_ACTOR });
    } else if (kind === "unsubscribe" && match.leadId) {
      await applyReplyEffects(db, {
        channel: "email",
        workspaceId,
        leadId: match.leadId,
        messageId: eventId,
        label: "asked_to_stop",
        event: "email_unsubscribe",
        optOutReason: "Unsubscribe request",
      });
    } else if (kind === "reply" && match.leadId) {
      await applyReply(db, workspaceId, eventId, parsed, match.leadId);
    }
    return kind;
  });
}

/** 5.x.x: our email `bounced`, the contact's email invalid (5.1.x) / permanent_bounce, and it counts toward the 5 % pause. */
async function applyBounce(db: Queryable, workspaceId: string, eventId: string, dsn: Dsn, match: Match) {
  if (match.outboundId) {
    await db.query(`update public.email_outbound_messages set bounced_at = coalesce(bounced_at, now()), bounce_status = $2 where id = $1`, [match.outboundId, dsn.status]);
  }
  const reason = `Email bounced: ${dsn.status}${dsn.diagnostic ? ` ${dsn.diagnostic}` : ""}`.slice(0, 300);
  if (match.leadId) {
    await db.query(
      `insert into public.lead_contact_channels (lead_id, channel, status, reason, updated_by_name)
       values ($1, 'email', $2, $3, 'Email bounce')
       on conflict (lead_id, channel) do update
         set status = excluded.status, reason = excluded.reason, updated_at = now(), updated_by = null, updated_by_name = excluded.updated_by_name`,
      [match.leadId, dsn.status.startsWith("5.1.") ? "invalid" : "permanent_bounce", reason],
    );
    await addTimelineEvent(db, {
      leadId: match.leadId,
      kind: "email",
      title: `Email bounced (${bounceReason(dsn.status)})`,
      detail: reason,
      metadata: { emailEventId: eventId, bounceStatus: dsn.status },
      ...SYSTEM_ACTOR,
    });
  }
  await recordEmailEvent(db, workspaceId, "recipient_rejected", reason);
  await checkAutoPause(db, workspaceId);
}

/** Rule 5: a matched reply behaves like a WhatsApp reply (4A + D2 + D4a), channel email. */
async function applyReply(db: Queryable, workspaceId: string, eventId: string, parsed: ParsedMail, leadId: string) {
  const { subject, text, truncated } = extractReplyText(parsed);
  // Subject + text, encrypted only; never logged, never in a timeline, task, notification or AI decision.
  const body = encryptText(JSON.stringify({ subject, text }), emailReplyAad(eventId));
  await db.query(
    `update public.email_inbound_events set body_ciphertext = $2, body_iv = $3, body_tag = $4, body_key_version = $5, text_truncated = $6 where id = $1`,
    [eventId, body.ciphertext, body.iv, body.tag, body.keyVersion, truncated],
  );

  const lead = (
    await db.query<LeadRef>(
      `select id, owner_id, agent_status, (select full_name from public.profiles p where p.id = leads.owner_id) as owner_name
         from public.leads where id = $1 for update`,
      [leadId],
    )
  ).rows[0]!;
  await stopAutomationForReply(db, lead.id, "Inbound email reply");
  await addTimelineEvent(db, { leadId: lead.id, kind: "email", title: "Replied by email", metadata: { emailReplyId: eventId }, ...SYSTEM_ACTOR });
  if (lead.owner_id) {
    await db.query(
      `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, lead_id, href)
       values ($1, $2, 'Email reply received', 'Automation was switched to manual.', 'info', $3, $4)`,
      [workspaceId, lead.owner_id, lead.id, `/contacts/${lead.id}`],
    );
  }
  await onAgentEvent(db, { workspaceId, leadId: lead.id, event: "email_inbound", payload: { emailReplyId: eventId } });
  const wasManaged = lead.agent_status === "active" || lead.agent_status === "paused";
  if (lead.owner_id && wasManaged) {
    await ensureReplyTask(db, workspaceId, { id: lead.id, owner_id: lead.owner_id, owner_name: lead.owner_name }, DEFAULT_EMAIL_REPLY_TASK_TITLE);
  }

  // D4a: keyword labels in every mode; the AI step only for AI contacts in a non-off mode.
  const keyword = matchReplyKeyword(text);
  const mode = (await db.query<{ mode: AgentMode }>(`select mode from public.agent_settings where workspace_id = $1`, [workspaceId])).rows[0]?.mode ?? "off";
  const label = { channel: "email" as const, workspaceId, leadId: lead.id, messageId: eventId };
  if (keyword) {
    await applyReplyLabel(db, { ...label, label: keyword, source: "keyword", status: "done" });
  } else if ((text || subject) && wasManaged && mode !== "off") {
    await db.query(`update public.email_inbound_events set classification_status = 'pending', classification_next_at = now() where id = $1`, [eventId]);
  } else {
    await applyReplyLabel(db, { ...label, label: "unclassified", source: "keyword", status: "skipped" });
  }
  // E3b-2a rule 1: a suggested reply for the owner (written by the worker once the label is known).
  await markReplyForDraft(db, { channel: "email", eventId, leadId: lead.id, eligible: Boolean(text || subject) && wasManaged && mode !== "off" && Boolean(lead.owner_id) });
}
