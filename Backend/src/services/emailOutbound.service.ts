import { randomUUID } from "node:crypto";
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { NotFoundError } from "../errors.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_EMAIL_ATTEMPTS,
  NOT_CONFIGURED_REASON,
  NOT_CONFIGURED_RETRY_MS,
  buildFromName,
  classifySmtpError,
  contactabilityForRejection,
  decideEmailSend,
  domainOf,
  htmlToText,
  isValidEmailAddress,
  listUnsubscribeHeader,
  messageIdFor,
  pauseReasonFor,
  retryDelayMs,
  shouldAutoPauseEmail,
  smtpReason,
  spacingAfterSend,
  warmupDayFor,
  type EmailSource,
} from "../domain/emailSafety.js";
import { PAUSED_RETRY_MS } from "../domain/whatsappSafety.js";
import { defaultTransportCache, type TransportCache } from "../providers/email.provider.js";
import { supabaseAdmin } from "../supabaseAdmin.js";
import { autoPauseEmail, loadEmailConnection, loadEmailStats, mailboxOf, recordEmailEvent } from "./emailConnection.service.js";
import { tryAdvanceToSent } from "./proposals.service.js";

/**
 * E1b: every email goes through this queue and is sent only by the worker
 * (`runEmailOutbound` in the tick). One row per (source, source_id), so an email is
 * never sent twice. Claim with SKIP LOCKED (`sending` is reclaimed after 15 min);
 * no DB transaction is held across the SMTP call.
 */

export interface AttachmentRef {
  bucket: string;
  path: string;
  fileName: string;
  mimeType: string;
  size: number | null;
}

export interface EmailOutboundRow {
  id: string;
  workspace_id: string;
  source: EmailSource;
  source_id: string;
  lead_id: string | null;
  to_address: string;
  from_name: string | null;
  to_contact: boolean;
  subject: string;
  html: string;
  text_body: string;
  attachments: AttachmentRef[];
  status: "queued" | "sending" | "sent" | "failed" | "cancelled";
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  smtp_response: string | null;
  message_id: string | null;
  dry_run: boolean;
  sent_at: Date | null;
}

export interface EnqueueEmailInput {
  workspaceId: string;
  source: EmailSource;
  sourceId: string;
  /** Emails to a contact: From "<owner> | <company>", List-Unsubscribe, recipient checks. */
  leadId?: string | null;
  to: string;
  subject: string;
  html: string;
  attachments?: AttachmentRef[];
  createdBy?: string | null;
}

/** Idempotent: a second call for the same (source, sourceId) returns the existing row. */
export async function enqueueEmail(db: Queryable, input: EnqueueEmailInput): Promise<EmailOutboundRow> {
  let fromName: string | null = null;
  if (input.leadId) {
    const owner = await db.query<{ owner_name: string | null; company_name: string }>(
      `select p.full_name as owner_name, coalesce(nullif(trim(s.company_display_name), ''), w.name) as company_name
         from public.leads l
         join public.workspaces w on w.id = l.workspace_id
         left join public.profiles p on p.id = l.owner_id
         left join public.agent_settings s on s.workspace_id = l.workspace_id
        where l.id = $1 and l.workspace_id = $2`,
      [input.leadId, input.workspaceId],
    );
    const row = owner.rows[0];
    fromName = row?.owner_name ? buildFromName("", row.owner_name, row.company_name) : null;
  }
  const inserted = await db.query<EmailOutboundRow>(
    `insert into public.email_outbound_messages
       (workspace_id, source, source_id, lead_id, to_address, from_name, to_contact, subject, html, text_body, attachments, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (source, source_id) do nothing
     returning *`,
    [
      input.workspaceId,
      input.source,
      input.sourceId,
      input.leadId ?? null,
      input.to.trim(),
      fromName,
      Boolean(input.leadId),
      input.subject,
      input.html,
      htmlToText(input.html),
      JSON.stringify(input.attachments ?? []),
      input.createdBy ?? null,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await db.query<EmailOutboundRow>(`select * from public.email_outbound_messages where source = $1 and source_id = $2`, [input.source, input.sourceId]);
  return existing.rows[0]!;
}

/**
 * A workflow send_email step: queue its email (once) and report where it is. A step
 * that was cancelled and is running again (resumed) re-queues its cancelled email.
 */
export async function queueEmailForAction(input: Omit<EnqueueEmailInput, "source">): Promise<EmailOutboundRow> {
  const row = await enqueueEmail(pool, { ...input, source: "scheduled_action" });
  if (row.status !== "cancelled") return row;
  const requeued = await pool.query<EmailOutboundRow>(
    `update public.email_outbound_messages set status = 'queued', next_attempt_at = now(), last_error = null
      where id = $1 and status = 'cancelled' returning *`,
    [row.id],
  );
  return requeued.rows[0] ?? row;
}

/** One due row per workspace (spacing makes more pointless), SKIP LOCKED; claiming pushes the reclaim time 15 min out. */
export async function claimDueEmails(db: Queryable, limit: number, workspaceIds: string[] | null = null): Promise<EmailOutboundRow[]> {
  const claimed = await db.query<EmailOutboundRow>(
    `update public.email_outbound_messages
        set status = 'sending', next_attempt_at = now() + interval '15 minutes'
      where id in (
        select id from public.email_outbound_messages
         where id in (
           select distinct on (workspace_id) id from public.email_outbound_messages
            where status in ('queued', 'sending') and next_attempt_at <= now()
              and ($2::uuid[] is null or workspace_id = any($2::uuid[]))
            order by workspace_id, next_attempt_at, created_at
         )
         limit $1
         for update skip locked
      )
      returning *`,
    [limit, workspaceIds],
  );
  return claimed.rows;
}

// ---------------------------------------------------------------------------
// Outcomes (each one short transaction) and their effect on the source row

async function onSourceSent(db: Queryable, row: EmailOutboundRow) {
  if (row.source === "proposal") {
    await db.query(`update public.proposals set email_send_status = 'sent', email_sent_at = now(), email_send_error = null where id = $1`, [row.source_id]);
  } else if (row.source === "meeting") {
    await db.query(`update public.meetings set notify_email_status = 'sent', notify_email_sent_at = now(), notify_email_error = null where id = $1`, [row.source_id]);
  }
}

async function onSourceProblem(db: Queryable, row: EmailOutboundRow, status: "pending" | "failed", error: string) {
  if (row.source === "proposal") {
    await db.query(`update public.proposals set email_send_status = $2, email_send_error = $3 where id = $1`, [row.source_id, status, error]);
  } else if (row.source === "meeting") {
    await db.query(`update public.meetings set notify_email_status = $2, notify_email_error = $3 where id = $1`, [row.source_id, status, error]);
  }
}

async function markSent(row: EmailOutboundRow, result: { messageId: string | null; response: string | null; dryRun: boolean }) {
  await withTransaction(async (db) => {
    await db.query(
      `update public.email_outbound_messages
          set status = 'sent', sent_at = now(), message_id = $2, smtp_response = $3, dry_run = $4, last_error = null
        where id = $1`,
      [row.id, result.messageId, result.response, result.dryRun],
    );
    await onSourceSent(db, row);
  });
  if (row.source === "proposal") await tryAdvanceToSent(row.workspace_id, row.source_id);
}

async function markFailed(db: Queryable, row: EmailOutboundRow, error: string, extra: { attempts?: number; response?: string | null } = {}) {
  await db.query(`update public.email_outbound_messages set status = 'failed', last_error = $2, attempts = coalesce($3, attempts), smtp_response = coalesce($4, smtp_response) where id = $1`, [
    row.id,
    error,
    extra.attempts ?? null,
    extra.response ?? null,
  ]);
  await onSourceProblem(db, row, "failed", error);
}

/** Back to `queued` until `at`; deferrals never burn attempts. */
async function requeue(db: Queryable, row: EmailOutboundRow, at: Date, reason: string, attempts = row.attempts) {
  await db.query(`update public.email_outbound_messages set status = 'queued', next_attempt_at = $2, last_error = $3, attempts = $4 where id = $1`, [
    row.id,
    at,
    reason,
    attempts,
  ]);
  await onSourceProblem(db, row, "pending", reason);
}

export async function checkAutoPause(db: Queryable, workspaceId: string) {
  const { row } = await loadEmailConnection(db, workspaceId);
  const reason = shouldAutoPauseEmail(await loadEmailStats(db, workspaceId, row.resumed_at));
  if (reason) await autoPauseEmail(db, workspaceId, reason);
}

// ---------------------------------------------------------------------------
// Recipient checks (rule 9)

async function recipientProblem(row: EmailOutboundRow): Promise<string | null> {
  if (!isValidEmailAddress(row.to_address)) return `"${row.to_address}" is not a valid email address.`;
  if (!row.lead_id) return null;
  const lead = await pool.query<{ lifecycle_state: string; email_status: string | null }>(
    `select l.lifecycle_state, c.status as email_status
       from public.leads l
       left join public.lead_contact_channels c on c.lead_id = l.id and c.channel = 'email'
      where l.id = $1`,
    [row.lead_id],
  );
  const r = lead.rows[0];
  if (!r) return "The contact no longer exists.";
  if (r.lifecycle_state === "do_not_contact") return "The contact is Do Not Contact.";
  const blocked: Record<string, string> = {
    invalid: "The contact's email address is marked invalid.",
    permanent_bounce: "The contact's email address bounced.",
    unsubscribed: "The contact unsubscribed from email.",
  };
  return r.email_status ? (blocked[r.email_status] ?? null) : null;
}

async function workflowStepActive(row: EmailOutboundRow): Promise<boolean> {
  const result = await pool.query<{ status: string }>(`select status from public.scheduled_actions where id = $1`, [row.source_id]);
  return ["pending", "due", "executing"].includes(result.rows[0]?.status ?? "");
}

async function staleMeetingReason(meetingId: string, now: Date): Promise<string | null> {
  const meeting = (await pool.query<{ status: string; scheduled_at: Date }>(`select status, scheduled_at from public.meetings where id = $1`, [meetingId])).rows[0];
  if (!meeting || meeting.status === "cancelled") return "Meeting was cancelled";
  return meeting.scheduled_at.getTime() <= now.getTime() ? "Meeting time has passed" : null;
}

async function downloadAttachment(ref: AttachmentRef): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage.from(ref.bucket).download(ref.path);
  if (error || !data) throw new Error(`Couldn't download the attachment "${ref.fileName}": ${error?.message ?? "no data"}`);
  return Buffer.from(await data.arrayBuffer());
}

const tooBig = (bytes: number) => `Attachments are ${(bytes / 1024 / 1024).toFixed(1)} MB; emails can carry at most 10 MB.`;

// ---------------------------------------------------------------------------
// Sending one claimed row

export interface EmailOutboundDeps {
  dryRun?: boolean;
  transports?: TransportCache;
  wait?: (ms: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
  download?: (ref: AttachmentRef) => Promise<Buffer>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function processEmail(row: EmailOutboundRow, deps: EmailOutboundDeps = {}): Promise<EmailOutboundRow["status"]> {
  const now = deps.now?.() ?? new Date();
  const random = deps.random ?? Math.random;

  if (row.source === "scheduled_action" && !(await workflowStepActive(row))) {
    await pool.query(`update public.email_outbound_messages set status = 'cancelled', last_error = $2 where id = $1`, [row.id, "The workflow step is no longer active."]);
    return "cancelled";
  }

  // D3 8b: a meeting email is pointless once the meeting was cancelled or has started.
  const stale = row.source === "meeting" ? await staleMeetingReason(row.source_id, now) : null;
  if (stale) {
    await withTransaction(async (db) => {
      await db.query(`update public.email_outbound_messages set status = 'cancelled', last_error = $2 where id = $1`, [row.id, stale]);
      await db.query(`update public.meetings set notify_email_status = 'skipped', notify_email_error = $2 where id = $1`, [row.source_id, stale]);
    });
    return "cancelled";
  }

  const problem = await recipientProblem(row);
  const declaredBytes = row.attachments.reduce((sum, a) => sum + (a.size ?? 0), 0);
  const block = problem ?? (declaredBytes > MAX_ATTACHMENT_BYTES ? tooBig(declaredBytes) : null);

  if (deps.dryRun && !block) {
    console.log(`[email] DRY RUN — would send ${row.source} email ${row.id}: ${row.subject}`);
    await markSent(row, { messageId: null, response: "DRY_RUN", dryRun: true });
    return "sent";
  }

  const { row: connection, secrets } = await loadEmailConnection(pool, row.workspace_id);
  const mailbox = mailboxOf(connection, secrets);
  if (!mailbox && !block) {
    await withTransaction((db) => requeue(db, row, new Date(now.getTime() + NOT_CONFIGURED_RETRY_MS), NOT_CONFIGURED_REASON));
    return "queued";
  }

  const stats = await loadEmailStats(pool, row.workspace_id, mailbox?.resumedAt ?? null);
  const decision = mailbox
    ? decideEmailSend({
        source: row.source,
        now,
        window: mailbox.window,
        dailyCap: mailbox.dailyCap,
        hourlyCap: mailbox.hourlyCap,
        warmupDay: warmupDayFor(mailbox.configuredAt, now),
        alreadyWarmed: mailbox.alreadyWarmed,
        sentToday: stats.sentToday,
        sentThisHour: stats.sentThisHour,
        paused: !mailbox.enabled,
        nextSendAt: mailbox.nextSendAt,
        recipientProblem: block,
        random,
      })
    : { block: block! };
  if ("block" in decision) {
    await withTransaction((db) => markFailed(db, row, decision.block));
    return "failed";
  }
  if ("defer" in decision) {
    await withTransaction((db) => requeue(db, row, decision.defer, decision.reason));
    return "queued";
  }

  const box = mailbox!;
  // Spacing: the next email of this workspace waits from this one.
  await pool.query(`update public.integration_connections set next_send_at = $2 where workspace_id = $1 and id = 'email'`, [
    row.workspace_id,
    new Date(now.getTime() + decision.spacingMs + spacingAfterSend(box.minDelaySeconds, box.maxDelaySeconds, random)),
  ]);
  if (decision.spacingMs > 0) await (deps.wait ?? sleep)(decision.spacingMs);

  const messageId = messageIdFor(domainOf(box.fromAddress));
  try {
    const files = await Promise.all(row.attachments.map(async (a) => ({ filename: a.fileName, content: await (deps.download ?? downloadAttachment)(a), contentType: a.mimeType })));
    const bytes = files.reduce((sum, f) => sum + f.content.length, 0);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      await withTransaction((db) => markFailed(db, row, tooBig(bytes)));
      return "failed";
    }
    const transport = (deps.transports ?? defaultTransportCache).get(row.workspace_id, box.transportKey, box.smtp);
    const info = await transport.sendMail({
      from: { name: row.from_name || box.fromName, address: box.fromAddress },
      to: row.to_address,
      replyTo: box.replyTo,
      subject: row.subject,
      html: row.html,
      text: row.text_body,
      messageId,
      date: now,
      headers: row.to_contact ? { "List-Unsubscribe": listUnsubscribeHeader(box.replyTo) } : {},
      attachments: files,
    });
    await markSent(row, { messageId, response: info.response ?? null, dryRun: false });
    return "sent";
  } catch (err) {
    return withTransaction((db) => recordSendError(db, row, err, now));
  }
}

async function recordSendError(db: Queryable, row: EmailOutboundRow, err: unknown, now: Date): Promise<EmailOutboundRow["status"]> {
  const kind = classifySmtpError(err);
  const reason = smtpReason(err);
  if (kind === "login_rejected" || kind === "rate_limited" || kind === "policy_blocked") {
    const pauseReason = pauseReasonFor(kind, err);
    await recordEmailEvent(db, row.workspace_id, kind === "login_rejected" ? "login_rejected" : "rate_limited", reason);
    await autoPauseEmail(db, row.workspace_id, pauseReason);
    await requeue(db, row, new Date(now.getTime() + PAUSED_RETRY_MS), pauseReason);
    return "queued";
  }
  if (kind === "recipient_permanent") {
    await recordEmailEvent(db, row.workspace_id, "recipient_rejected", reason);
    await markFailed(db, row, `The recipient's mail server rejected the email: ${reason}`, { attempts: row.attempts + 1, response: reason });
    if (row.lead_id) {
      await db.query(
        `insert into public.lead_contact_channels (lead_id, channel, status, reason, updated_by_name)
         values ($1, 'email', $2, $3, 'Email sender')
         on conflict (lead_id, channel) do update
           set status = excluded.status, reason = excluded.reason, updated_at = now(), updated_by = null, updated_by_name = excluded.updated_by_name`,
        [row.lead_id, contactabilityForRejection(err), reason],
      );
    }
    await checkAutoPause(db, row.workspace_id);
    return "failed";
  }
  const attempts = row.attempts + 1;
  await recordEmailEvent(db, row.workspace_id, "send_failed", reason);
  if (attempts >= MAX_EMAIL_ATTEMPTS) await markFailed(db, row, `Gave up after ${attempts} attempts: ${reason}`, { attempts });
  else await requeue(db, row, new Date(now.getTime() + retryDelayMs(attempts)), `Temporary error, will retry: ${reason}`, attempts);
  await checkAutoPause(db, row.workspace_id);
  return attempts >= MAX_EMAIL_ATTEMPTS ? "failed" : "queued";
}

/** Worker tick: claim (one per workspace) and send, workspaces in parallel. */
export async function runEmailOutbound(deps: EmailOutboundDeps & { limit?: number; /** Tests: only these workspaces. */ workspaceIds?: string[] } = {}) {
  const claimed = await withTransaction((db) => claimDueEmails(db, deps.limit ?? 10, deps.workspaceIds ?? null));
  return Promise.all(
    claimed.map((row) =>
      processEmail(row, deps).catch(async (err: { code?: string; name?: string }) => {
        // Codes only: messages can quote addresses. The row is reclaimed after 15 min.
        console.error(`[email] Processing ${row.id} failed: ${err?.code ?? err?.name ?? "unknown error"}`);
        return "sending" as const;
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Settings → "Send test email to me"

export async function queueTestEmail(workspaceId: string, actor: { id: string; email: string }) {
  const row = await enqueueEmail(pool, {
    workspaceId,
    source: "test",
    sourceId: randomUUID(),
    to: actor.email,
    subject: "Northbeam CRM test email",
    html: "<p>This is a test email from Northbeam CRM.</p><p>If it arrived in your inbox (not spam), sending from this mailbox works.</p>",
    createdBy: actor.id,
  });
  return { id: row.id, status: row.status };
}

export async function getTestEmail(workspaceId: string, id: string) {
  const result = await pool.query<EmailOutboundRow>(`select * from public.email_outbound_messages where id = $1 and workspace_id = $2 and source = 'test'`, [id, workspaceId]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Test email");
  return { id: row.id, status: row.status, to: row.to_address, lastError: row.last_error, sentAt: row.sent_at?.toISOString() ?? null, dryRun: row.dry_run };
}
