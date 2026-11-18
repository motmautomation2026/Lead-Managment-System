/**
 * npm run staging:seed-reply-draft -- --contact "<full name>" [--with-reply ["<text>"]]
 * npm run staging:seed-reply-draft -- --remove [--contact "<full name>"]
 *
 * STAGING ONLY (E3b-2a-2 rule 4): inserts ONE open suggested reply (fixed sample text, no AI call, cost 0) for a
 * seeded AI test contact's latest matched reply, so the Suggested reply card can be tested for free. Refuses any
 * database but staging, a contact that isn't a seeded test contact ("AI test seed"), a contact with no matched
 * reply, and a contact that already has an open suggested reply.
 * --with-reply first stores one fake matched reply from the contact (WhatsApp if usable, else email), like a real
 * one: encrypted text, a timeline row, label `question` (keyword, skipped: no AI step), and the reply task the real
 * path would create (AI-managed contact with an owner, none open), already marked escalated so the 2-hour
 * escalation never fires. Nothing is sent, queued for the worker or notified.
 * --remove deletes what this script created (markers: reply_drafts.model = 'staging-seed', reply ids starting with
 * 'staging-seed-', timeline rows with metadata.seeded), plus any queued (not yet sent) email or WhatsApp send of a
 * seeded draft, for the named contact or all seeded contacts. A seeded draft can never be sent (E3b-2b rule 3: 409).
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Queryable } from "../src/dto.js";
import { replyTaskTitle, REPLY_TASK_TITLES } from "../src/agent/replyClassification.js";
import { contactSendProblem, SEEDED_DRAFT_MODEL } from "../src/domain/replyDrafts.js";
import { assertStagingDatabase, SEED_MARKER } from "./seed-ai-test-contacts.js";

// E3b-2b rule 3: this marker also makes the API refuse to send the draft (409).
export const SEED_DRAFT_MODEL = SEEDED_DRAFT_MODEL;
export const SEED_REPLY_PREFIX = "staging-seed-";
export const DEFAULT_REPLY_TEXT = "Hi, can you share how you would find buyers for us?";
export const SAMPLE_BODY: Record<"whatsapp" | "email", string> = {
  whatsapp: "Thanks for your message. Happy to go through it on a short call. Would Thursday or Friday suit you?",
  email: "Hi,\n\nThanks for your reply. Happy to go through it on a short call.\n\nWould Thursday or Friday suit you?",
};
const SAMPLE_SUBJECT = "Re: your message";
const SEED_ACTOR = "Staging seed";

interface SeededContact {
  id: string;
  workspace_id: string;
  name: string;
  owner_id: string | null;
  owner_name: string | null;
  agent_status: string;
  lifecycle_state: string;
  phone_e164: string | null;
  email: string | null;
  whatsapp_status: string | null;
  email_status: string | null;
  phone_status: string | null;
}

async function findSeededContact(db: Queryable, fullName: string, workspaceId?: string) {
  const rows = (
    await db.query<SeededContact>(
      `select l.id, l.workspace_id, trim(concat_ws(' ', l.first_name, l.last_name)) as name, l.owner_id,
              (select full_name from public.profiles p where p.id = l.owner_id) as owner_name, l.agent_status::text as agent_status,
              l.lifecycle_state::text as lifecycle_state, l.phone_e164, l.email,
              (select status from public.lead_contact_channels c where c.lead_id = l.id and c.channel = 'whatsapp') as whatsapp_status,
              (select status from public.lead_contact_channels c where c.lead_id = l.id and c.channel = 'email') as email_status,
              (select status from public.lead_contact_channels c where c.lead_id = l.id and c.channel = 'phone') as phone_status
         from public.leads l
        where l.created_by_name = $1 and lower(trim(concat_ws(' ', l.first_name, l.last_name))) = lower(trim($2))
          and l.merged_into_lead_id is null and ($3::uuid is null or l.workspace_id = $3)`,
      [SEED_MARKER, fullName, workspaceId ?? null],
    )
  ).rows;
  if (!rows.length) throw new Error(`"${fullName}" is not a seeded AI test contact; refusing.`);
  if (rows.length > 1) throw new Error(`"${fullName}" matches ${rows.length} seeded contacts; refusing.`);
  return rows[0]!;
}

/** The fake reply's channel: WhatsApp when a WhatsApp send would be allowed, else email; null = neither. */
function usableChannel(lead: SeededContact): "whatsapp" | "email" | null {
  const base = { lifecycleState: lead.lifecycle_state, phoneStatus: lead.phone_status };
  if (!contactSendProblem({ ...base, channel: "whatsapp", channelStatus: lead.whatsapp_status, address: lead.phone_e164 })) return "whatsapp";
  if (!contactSendProblem({ ...base, channel: "email", channelStatus: lead.email_status, address: lead.email })) return "email";
  return null;
}

/** --with-reply: one fake matched reply, stored like a real one (no AI step, no send, no notification). */
async function insertFakeReply(db: Queryable, lead: SeededContact, text: string): Promise<"whatsapp" | "email"> {
  const channel = usableChannel(lead);
  if (!channel) throw new Error(`${lead.name} has no usable WhatsApp number or email address; refusing.`);
  // Loaded here: encryption reads env at import, after main() has loaded .env.
  const { encryptText } = await import("../src/security/encryption.js");
  const { emailReplyAad, whatsappReplyAad } = await import("../src/services/inboundReplies.service.js");
  const label = { reply_label: "question", reply_label_source: "keyword", classification_status: "skipped" };
  let ref: Record<string, string>;
  if (channel === "whatsapp") {
    const id = `${SEED_REPLY_PREFIX}${randomUUID()}`;
    const body = encryptText(text, whatsappReplyAad(id));
    await db.query(
      `insert into public.whatsapp_inbound_events
         (message_id, workspace_id, sender_jid, sender_phone_e164, message_type, received_at, match_count, disposition, lead_id,
          body_ciphertext, body_iv, body_tag, body_key_version, body_truncated, reply_label, reply_label_source, classification_status, classified_at)
       values ($1, $2, $3, $4, 'conversation', now(), 1, 'matched', $5, $6, $7, $8, $9, false, $10, $11, $12, now())`,
      [id, lead.workspace_id, `${lead.phone_e164!.replace(/\D/g, "")}@s.whatsapp.net`, lead.phone_e164, lead.id, body.ciphertext, body.iv, body.tag, body.keyVersion, label.reply_label, label.reply_label_source, label.classification_status],
    );
    ref = { messageId: id, messageType: "conversation" };
  } else {
    const id = randomUUID();
    const body = encryptText(JSON.stringify({ subject: "Re: your message", text }), emailReplyAad(id));
    await db.query(
      `insert into public.email_inbound_events
         (id, workspace_id, message_id_header, uidvalidity, uid, from_address, received_at, kind, match_status, match_method, lead_id,
          body_ciphertext, body_iv, body_tag, body_key_version, reply_label, reply_label_source, classification_status, classified_at)
       values ($1, $2, $3, 0, 0, $4, now(), 'reply', 'matched', 'sender', $5, $6, $7, $8, $9, $10, $11, $12, now())`,
      [id, lead.workspace_id, `<${SEED_REPLY_PREFIX}${id}@seed.invalid>`, lead.email, lead.id, body.ciphertext, body.iv, body.tag, body.keyVersion, label.reply_label, label.reply_label_source, label.classification_status],
    );
    ref = { emailReplyId: id };
  }

  // The reply task the real path creates (AI-managed before the reply, with an owner, none open). escalated_at set: no 2-hour alert.
  let taskId: string | null = null;
  const managed = lead.agent_status === "active" || lead.agent_status === "paused";
  const open = await db.query(`select 1 from public.tasks where lead_id = $1 and origin = 'agent' and status = 'open' and title = any($2::text[])`, [lead.id, REPLY_TASK_TITLES]);
  if (managed && lead.owner_id && !open.rowCount) {
    const due = new Date(Math.floor((Date.now() + 330 * 60_000) / 86_400_000 + 1) * 86_400_000 - 330 * 60_000 - 1000);
    taskId = (
      await db.query<{ id: string }>(
        `insert into public.tasks (workspace_id, lead_id, owner_id, owner_name, task_type, title, due_at, origin, escalated_at)
         values ($1, $2, $3, $4, 'follow_up', $5, $6, 'agent', now()) returning id`,
        [lead.workspace_id, lead.id, lead.owner_id, lead.owner_name, replyTaskTitle("question", channel), due],
      )
    ).rows[0]!.id;
  }
  await db.query(
    `insert into public.timeline_events (lead_id, event_kind, title, actor_name, actor_source, metadata)
     values ($1, $2, $3, $4, 'system', $5)`,
    [lead.id, channel, channel === "whatsapp" ? "WhatsApp reply received - automation stopped" : "Replied by email", SEED_ACTOR, { ...ref, seeded: true, seededTaskId: taskId }],
  );
  return channel;
}

/** Inserts the open sample draft (after the fake reply with `withReply`); returns what it did. Throws on every refusal. */
export async function seedReplyDraft(db: Queryable, input: { contact: string; workspaceId?: string; withReply?: string }): Promise<string> {
  const lead = await findSeededContact(db, input.contact, input.workspaceId);
  const open = await db.query(`select 1 from public.reply_drafts where lead_id = $1 and status = 'open'`, [lead.id]);
  if (open.rowCount) throw new Error(`${lead.name} already has an open suggested reply; send or discard it first (or --remove).`);
  const faked = input.withReply !== undefined ? await insertFakeReply(db, lead, input.withReply) : null;
  const reply = (
    await db.query<{ channel: "whatsapp" | "email"; id: string; in_reply_to: string | null; received_at: Date }>(
      `select * from (
         select 'whatsapp' as channel, message_id as id, null::text as in_reply_to, received_at
           from public.whatsapp_inbound_events where lead_id = $1 and disposition = 'matched'
         union all
         select 'email', id::text, message_id_header, received_at
           from public.email_inbound_events where lead_id = $1 and kind = 'reply' and match_status = 'matched'
       ) r order by received_at desc limit 1`,
      [lead.id],
    )
  ).rows[0];
  if (!reply) throw new Error(`${lead.name} has no matched reply (WhatsApp or email); refusing. Add --with-reply to create a fake one.`);
  const taken = await db.query(`select 1 from public.reply_drafts where ${reply.channel === "email" ? "email_event_id::text" : "whatsapp_message_id"} = $1`, [reply.id]);
  if (taken.rowCount) throw new Error(`${lead.name}'s latest reply already had a suggested reply; refusing.`);

  const draft = await db.query<{ id: string }>(
    `insert into public.reply_drafts
       (workspace_id, lead_id, channel, whatsapp_message_id, email_event_id, subject, body, in_reply_to, status, model, input_tokens, output_tokens, cost_usd)
     values ($1, $2, $3, $4, $5::uuid, $6, $7, $8, 'open', $9, 0, 0, 0)
     returning id`,
    [
      lead.workspace_id,
      lead.id,
      reply.channel,
      reply.channel === "whatsapp" ? reply.id : null,
      reply.channel === "email" ? reply.id : null,
      reply.channel === "email" ? SAMPLE_SUBJECT : null,
      SAMPLE_BODY[reply.channel],
      reply.in_reply_to,
      SEED_DRAFT_MODEL,
    ],
  );
  const what = `an open ${reply.channel === "email" ? "email" : "WhatsApp"} suggested reply ${draft.rows[0]!.id} for ${lead.name} (lead ${lead.id})`;
  return faked ? `Seeded a fake ${faked === "email" ? "email" : "WhatsApp"} reply and ${what}.` : `Seeded ${what} on the reply of ${reply.received_at.toISOString()}.`;
}

export interface RemovedCounts {
  drafts: number;
  replies: number;
  tasks: number;
  timeline: number;
  queuedEmails: number;
  queuedWhatsApp: number;
}

/** Deletes what this script created (seeded contacts only), for one contact or all; returns the counts. */
export async function removeSeededReplyDrafts(db: Queryable, input: { contact?: string; workspaceId?: string } = {}): Promise<RemovedCounts> {
  const leadId = input.contact ? (await findSeededContact(db, input.contact, input.workspaceId)).id : null;
  const leads = (
    await db.query<{ id: string }>(`select id from public.leads where created_by_name = $1 and ($2::uuid is null or id = $2) and ($3::uuid is null or workspace_id = $3)`, [
      SEED_MARKER,
      leadId,
      input.workspaceId ?? null,
    ])
  ).rows.map((r) => r.id);
  const like = `${SEED_REPLY_PREFIX}%`;
  const seededDrafts = `select d.id from public.reply_drafts d
     left join public.whatsapp_inbound_events w on w.message_id = d.whatsapp_message_id
     left join public.email_inbound_events e on e.id = d.email_event_id
    where d.lead_id = any($1::uuid[]) and (d.model = $2 or w.message_id like $3 or e.message_id_header like '<' || $3)`;
  // A rep's Send of a seeded draft must never reach the worker.
  const queuedEmails = await db.query(
    `delete from public.email_outbound_messages where source = 'reply_draft' and status <> 'sent' and source_id in (${seededDrafts})`,
    [leads, SEED_DRAFT_MODEL, like],
  );
  // A WhatsApp Send is queued on the draft row itself (plus a prepared outbound row while sending): both go with the draft.
  const queuedWhatsApp = await db.query(`select 1 from public.reply_drafts where id in (${seededDrafts}) and channel = 'whatsapp' and send_status in ('queued', 'sending')`, [
    leads,
    SEED_DRAFT_MODEL,
    like,
  ]);
  await db.query(`delete from public.whatsapp_outbound_messages where status <> 'sent' and reply_draft_id in (${seededDrafts})`, [leads, SEED_DRAFT_MODEL, like]);
  const drafts = await db.query(`delete from public.reply_drafts where id in (${seededDrafts})`, [leads, SEED_DRAFT_MODEL, like]);
  const taskIds = (
    await db.query<{ id: string }>(`select metadata->>'seededTaskId' as id from public.timeline_events where lead_id = any($1::uuid[]) and metadata->>'seeded' = 'true' and metadata->>'seededTaskId' is not null`, [leads])
  ).rows.map((r) => r.id);
  const tasks = await db.query(`delete from public.tasks where id = any($1::uuid[]) and origin = 'agent' and lead_id = any($2::uuid[])`, [taskIds, leads]);
  const timeline = await db.query(`delete from public.timeline_events where lead_id = any($1::uuid[]) and metadata->>'seeded' = 'true'`, [leads]);
  // Reads of the fake text were audited; the audit rows go with the fake reply.
  await db.query(
    `delete from public.inbound_message_views where lead_id = any($1::uuid[])
        and (message_id like $2 or email_event_id in (select id from public.email_inbound_events where lead_id = any($1::uuid[]) and message_id_header like '<' || $2))`,
    [leads, like],
  );
  const wa = await db.query(`delete from public.whatsapp_inbound_events where lead_id = any($1::uuid[]) and message_id like $2`, [leads, like]);
  const mail = await db.query(`delete from public.email_inbound_events where lead_id = any($1::uuid[]) and message_id_header like '<' || $2`, [leads, like]);
  return {
    drafts: drafts.rowCount ?? 0,
    replies: (wa.rowCount ?? 0) + (mail.rowCount ?? 0),
    tasks: tasks.rowCount ?? 0,
    timeline: timeline.rowCount ?? 0,
    queuedEmails: queuedEmails.rowCount ?? 0,
    queuedWhatsApp: queuedWhatsApp.rowCount ?? 0,
  };
}

/** `--with-reply` alone (or followed by another flag) means the default text. */
export function withReplyArg(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--with-reply");
  if (index < 0) return undefined;
  const next = argv[index + 1];
  return next && !next.startsWith("--") && next.trim() ? next : DEFAULT_REPLY_TEXT;
}

async function main() {
  await import("dotenv/config");
  assertStagingDatabase(process.env.DATABASE_URL);
  const index = process.argv.indexOf("--contact");
  const contact = index >= 0 ? process.argv[index + 1] : undefined;
  const remove = process.argv.includes("--remove");
  if (!remove && !contact) throw new Error('Usage: npm run staging:seed-reply-draft -- --contact "<full name>" [--with-reply ["<text>"]]  |  -- --remove [--contact "<full name>"]');
  process.env.NORTHBEAM_DB_ROLE = "script";
  const { pool, withTransaction } = await import("../src/db.js");
  try {
    if (remove) {
      const n = await withTransaction((db) => removeSeededReplyDrafts(db, { contact }));
      console.log(`Removed ${n.drafts} seeded suggested reply draft(s), ${n.replies} fake repl(ies), ${n.tasks} reply task(s), ${n.timeline} timeline row(s), ${n.queuedEmails} queued email(s), ${n.queuedWhatsApp} queued WhatsApp send(s).`);
    } else {
      console.log(await withTransaction((db) => seedReplyDraft(db, { contact: contact!, withReply: withReplyArg(process.argv) })));
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
