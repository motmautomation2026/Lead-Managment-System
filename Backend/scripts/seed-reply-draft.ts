/**
 * npm run staging:seed-reply-draft -- --contact "<full name>"
 * npm run staging:seed-reply-draft -- --remove [--contact "<full name>"]
 *
 * STAGING ONLY (E3b-2a-2 rule 4): inserts ONE open suggested reply (fixed sample text, no AI call, cost 0) for a
 * seeded AI test contact's latest matched reply, so the Suggested reply card can be tested for free. Refuses any
 * database but staging, a contact that isn't a seeded test contact ("AI test seed"), a contact with no matched
 * reply, and a contact that already has an open suggested reply. --remove deletes the drafts this script created
 * (marker: reply_drafts.model = 'staging-seed'), for the named contact or all seeded contacts.
 */
import { pathToFileURL } from "node:url";
import type { Queryable } from "../src/dto.js";
import { assertStagingDatabase, SEED_MARKER } from "./seed-ai-test-contacts.js";

export const SEED_DRAFT_MODEL = "staging-seed";
export const SAMPLE_BODY: Record<"whatsapp" | "email", string> = {
  whatsapp: "Thanks for your message. Happy to go through it on a short call. Would Thursday or Friday suit you?",
  email: "Hi,\n\nThanks for your reply. Happy to go through it on a short call.\n\nWould Thursday or Friday suit you?",
};
const SAMPLE_SUBJECT = "Re: your message";

async function findSeededContact(db: Queryable, fullName: string, workspaceId?: string) {
  const rows = (
    await db.query<{ id: string; workspace_id: string; name: string }>(
      `select id, workspace_id, trim(concat_ws(' ', first_name, last_name)) as name from public.leads
        where created_by_name = $1 and lower(trim(concat_ws(' ', first_name, last_name))) = lower(trim($2))
          and merged_into_lead_id is null and ($3::uuid is null or workspace_id = $3)`,
      [SEED_MARKER, fullName, workspaceId ?? null],
    )
  ).rows;
  if (!rows.length) throw new Error(`"${fullName}" is not a seeded AI test contact; refusing.`);
  if (rows.length > 1) throw new Error(`"${fullName}" matches ${rows.length} seeded contacts; refusing.`);
  return rows[0]!;
}

/** Inserts the open sample draft; returns what it did. Throws (changes nothing) on every refusal. */
export async function seedReplyDraft(db: Queryable, input: { contact: string; workspaceId?: string }): Promise<string> {
  const lead = await findSeededContact(db, input.contact, input.workspaceId);
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
  if (!reply) throw new Error(`${lead.name} has no matched reply (WhatsApp or email); refusing.`);
  const open = await db.query(`select 1 from public.reply_drafts where lead_id = $1 and status = 'open'`, [lead.id]);
  if (open.rowCount) throw new Error(`${lead.name} already has an open suggested reply; send or discard it first (or --remove).`);
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
  return `Seeded an open ${reply.channel === "email" ? "email" : "WhatsApp"} suggested reply ${draft.rows[0]!.id} for ${lead.name} (lead ${lead.id}) on the reply of ${reply.received_at.toISOString()}.`;
}

/** Deletes the drafts this script created (seeded contacts only); returns how many. */
export async function removeSeededReplyDrafts(db: Queryable, input: { contact?: string; workspaceId?: string } = {}): Promise<number> {
  const leadId = input.contact ? (await findSeededContact(db, input.contact, input.workspaceId)).id : null;
  const removed = await db.query(
    `delete from public.reply_drafts d using public.leads l
      where l.id = d.lead_id and l.created_by_name = $1 and d.model = $2
        and ($3::uuid is null or d.lead_id = $3) and ($4::uuid is null or d.workspace_id = $4)`,
    [SEED_MARKER, SEED_DRAFT_MODEL, leadId, input.workspaceId ?? null],
  );
  return removed.rowCount ?? 0;
}

async function main() {
  await import("dotenv/config");
  assertStagingDatabase(process.env.DATABASE_URL);
  const index = process.argv.indexOf("--contact");
  const contact = index >= 0 ? process.argv[index + 1] : undefined;
  const remove = process.argv.includes("--remove");
  if (!remove && !contact) throw new Error('Usage: npm run staging:seed-reply-draft -- --contact "<full name>"  |  -- --remove [--contact "<full name>"]');
  process.env.NORTHBEAM_DB_ROLE = "script";
  const { pool } = await import("../src/db.js");
  try {
    if (remove) console.log(`Removed ${await removeSeededReplyDrafts(pool, { contact })} seeded suggested reply draft(s).`);
    else console.log(await seedReplyDraft(pool, { contact: contact! }));
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
