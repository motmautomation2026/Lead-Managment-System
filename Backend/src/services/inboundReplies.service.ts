/**
 * D2: the text of one inbound WhatsApp reply, for the contact's owner and admins.
 * `decryptInboundBody` is the only decrypt of `whatsapp_inbound_events.body_*`
 * (also used by the D4a worker classifier). Every read that
 * reaches a matched reply of the contact is audited in `inbound_message_views`.
 * Never log, throw or store the decrypted text.
 */
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { decryptText } from "../security/encryption.js";

export const REPLY_FORBIDDEN_MESSAGE = "Only the contact owner and admins can read replies.";

export const canReadReplies = (actor: Actor, ownerId: string | null) => actor.role === "admin" || ownerId === actor.id;

type Outcome = "shown" | "denied" | "no_text" | "decrypt_failed";

export interface InboundReply {
  messageId: string;
  receivedAt: string;
  text: string | null;
  truncated: boolean;
  reason?: "not_stored" | "unreadable";
}

export interface InboundBody {
  body_ciphertext: Buffer | null;
  body_iv: Buffer | null;
  body_tag: Buffer | null;
  body_key_version: number | null;
}

interface EventRow extends InboundBody {
  owner_id: string | null;
  received_at: Date;
  body_truncated: boolean;
}

/** The reply text, null when none was stored; throws when it can't be decrypted. Never log the result. */
export function decryptInboundBody(row: InboundBody, messageId: string): string | null {
  if (!row.body_ciphertext || !row.body_iv || !row.body_tag || row.body_key_version === null) return null;
  return decryptText(
    { ciphertext: row.body_ciphertext, iv: row.body_iv, tag: row.body_tag, keyVersion: row.body_key_version },
    `whatsapp:inbound:${messageId}`,
  );
}

/** 404 unless the reply is a matched event of this contact in this workspace (its timeline row links them). */
export async function readInboundReply(db: Queryable, actor: Actor, workspaceId: string, leadId: string, messageId: string): Promise<InboundReply> {
  const row = (
    await db.query<EventRow>(
      `select l.owner_id, e.received_at, e.body_ciphertext, e.body_iv, e.body_tag, e.body_key_version, e.body_truncated
         from public.leads l
         join public.whatsapp_inbound_events e on e.workspace_id = l.workspace_id and e.message_id = $3 and e.disposition = 'matched'
        where l.id = $1 and l.workspace_id = $2
          and exists (select 1 from public.timeline_events t
                       where t.lead_id = l.id and t.event_kind = 'whatsapp' and t.metadata->>'messageId' = e.message_id)`,
      [leadId, workspaceId, messageId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Reply");

  const audit = (outcome: Outcome) =>
    db.query(
      `insert into public.inbound_message_views (workspace_id, lead_id, message_id, viewer_id, outcome) values ($1, $2, $3, $4, $5)`,
      [workspaceId, leadId, messageId, actor.id, outcome],
    );

  if (!canReadReplies(actor, row.owner_id)) {
    await audit("denied");
    throw new ForbiddenError(REPLY_FORBIDDEN_MESSAGE);
  }
  const base = { messageId, receivedAt: row.received_at.toISOString(), truncated: row.body_truncated };
  let text: string | null;
  try {
    text = decryptInboundBody(row, messageId);
  } catch {
    // Wrong key, rotated key or tampered row. Ids only: never the ciphertext.
    console.warn(`[replies] could not decrypt inbound message ${messageId} (key version ${row.body_key_version})`);
    await audit("decrypt_failed");
    return { ...base, text: null, reason: "unreadable" };
  }
  if (text === null) {
    await audit("no_text");
    return { ...base, text: null, reason: "not_stored" };
  }
  await audit("shown");
  return { ...base, text };
}
