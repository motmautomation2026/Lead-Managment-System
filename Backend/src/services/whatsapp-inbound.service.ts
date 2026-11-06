import { getContentType, type WAMessage } from "baileys";
import { withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { jidToPhoneE164 } from "../domain/phone.js";
import { addTimelineEvent, SYSTEM_ACTOR } from "./timeline.service.js";
import { onAgentEvent } from "./agentEvents.service.js";
import { createTask } from "./tasks.service.js";
import { extractInboundText } from "../domain/whatsappInboundText.js";
import { encryptText } from "../security/encryption.js";
import type { AgentMode, AgentStatus } from "../agent/rules.js";
import { matchReplyKeyword } from "../domain/replyKeywords.js";
import { DEFAULT_REPLY_TASK_TITLE, REPLY_TASK_TITLES } from "../agent/replyClassification.js";
import { applyReplyLabel } from "./replyLabels.service.js";
import { isReplyFollowUp, markReplyForDraft } from "./replyDrafts.service.js";

export const REPLY_TASK_TITLE = DEFAULT_REPLY_TASK_TITLE;
const IST_OFFSET_MS = 330 * 60_000;

/** 23:59 today, Asia/Kolkata (fixed UTC+05:30). */
export function endOfIstDay(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(23, 59, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/**
 * A reply stops automation (4A; D3: email too): the contact responded, goes manual, and its
 * workflow runs and scheduled actions are cancelled with `reason`.
 */
export async function stopAutomationForReply(db: Queryable, leadId: string, reason: string) {
  await db.query(
    `update public.leads
        set response_state = 'responded', automation_mode = 'manual', last_activity_at = now()
      where id = $1`,
    [leadId],
  );
  await db.query(
    `update public.workflow_runs
        set status = 'cancelled', cancelled_at = now(), cancel_reason = $2, next_run_at = null
      where lead_id = $1 and status in ('running','waiting','paused')`,
    [leadId, reason],
  );
  await db.query(
    `update public.scheduled_actions
        set status = 'cancelled', cancelled_at = now(), cancel_reason = $2
      where lead_id = $1 and status in ('pending','due','paused','executing')`,
    [leadId, reason],
  );
}

/** One open reply task per contact across channels (any reply-task title counts: a label may have re-titled it). */
export async function ensureReplyTask(db: Queryable, workspaceId: string, lead: { id: string; owner_id: string; owner_name: string | null }, title: string) {
  const open = await db.query(
    `select 1 from public.tasks where lead_id = $1 and origin = 'agent' and status = 'open' and title = any($2::text[]) limit 1`,
    [lead.id, REPLY_TASK_TITLES],
  );
  if (open.rowCount) return;
  await createTask(db, null, workspaceId, {
    leadId: lead.id,
    ownerId: lead.owner_id,
    ownerName: lead.owner_name,
    type: "follow_up",
    title,
    dueAt: endOfIstDay().toISOString(),
    origin: "agent",
  });
}

function messageTime(message: WAMessage) {
  const raw = message.messageTimestamp;
  const seconds = typeof raw === "number" ? raw : Number(raw?.toString() ?? 0);
  return new Date((seconds || Math.floor(Date.now() / 1000)) * 1000);
}

/**
 * `workspaceId` identifies which workspace's Baileys socket received this
 * message (see baileys.manager.ts — each workspace owns its own socket), so
 * lead matching is scoped to that workspace's leads only: a phone number
 * that happens to match a lead in a different workspace must never stop
 * that other workspace's automation or notify that other workspace's owner.
 */
export async function processInboundUpsert(workspaceId: string, event: { messages: WAMessage[]; type: string; requestId?: string }) {
  if (event.type !== "notify" || event.requestId) return;
  for (const message of event.messages) {
    const id = message.key.id;
    const directJid = [message.key.remoteJid, message.key.remoteJidAlt].find(
      (jid): jid is string => Boolean(jid?.endsWith("@s.whatsapp.net")),
    );
    if (!id || !directJid || message.key.fromMe || !message.message) continue;
    const phone = jidToPhoneE164(directJid);
    if (!phone) continue;
    const type = getContentType(message.message) ?? "unknown";

    await withTransaction(async (db) => {
      await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [phone]);
      const inserted = await db.query(
        `insert into public.whatsapp_inbound_events
          (workspace_id, message_id, sender_jid, sender_phone_e164, message_type, received_at, disposition)
         values ($1,$2,$3,$4,$5,$6,'unmatched')
         on conflict (message_id) do nothing
         returning message_id`,
        [workspaceId, id, directJid, phone, type, messageTime(message).toISOString()],
      );
      if (inserted.rowCount === 0) return;

      const matches = await db.query<{ id: string; owner_id: string | null; owner_name: string | null; agent_status: AgentStatus }>(
        `select id, owner_id, agent_status, (select full_name from public.profiles p where p.id = leads.owner_id) as owner_name
           from public.leads
          where phone_e164 = $1 and workspace_id = $2 and lifecycle_state = 'active' and merged_into_lead_id is null
          for update`,
        [phone, workspaceId],
      );
      const disposition = matches.rowCount === 0 ? "unmatched" : matches.rowCount === 1 ? "matched" : "ambiguous";
      await db.query(
        `update public.whatsapp_inbound_events set match_count = $2, disposition = $3 where message_id = $1`,
        [id, matches.rowCount, disposition],
      );

      // The text is stored only encrypted and only for a single matched lead; never log it.
      let hasText = false;
      let keyword: ReturnType<typeof matchReplyKeyword> = null;
      if (disposition === "matched") {
        const { text, truncated } = extractInboundText(message.message);
        hasText = Boolean(text);
        keyword = matchReplyKeyword(text);
        await db.query(`update public.whatsapp_inbound_events set lead_id = $2 where message_id = $1`, [id, matches.rows[0]!.id]);
        if (text) {
          const body = encryptText(text, `whatsapp:inbound:${id}`);
          await db.query(
            `update public.whatsapp_inbound_events
                set body_ciphertext = $2, body_iv = $3, body_tag = $4, body_key_version = $5, body_truncated = $6
              where message_id = $1`,
            [id, body.ciphertext, body.iv, body.tag, body.keyVersion, truncated],
          );
        }
      }

      for (const lead of matches.rows) {
        await stopAutomationForReply(db, lead.id, "Inbound WhatsApp reply");
        await db.query(
          `insert into public.lead_contact_channels
            (lead_id, channel, status, reason, updated_by_name)
           values ($1, 'whatsapp', 'reachable', 'Inbound reply received', 'WhatsApp')
           on conflict (lead_id, channel) do update
             set status = 'reachable', reason = excluded.reason, updated_at = now(), updated_by = null, updated_by_name = 'WhatsApp'
             -- A STOP opt-out (D4a) stays until a person clears it.
             where lead_contact_channels.status <> 'opted_out'`,
          [lead.id],
        );
        await addTimelineEvent(db, {
          leadId: lead.id,
          kind: "whatsapp",
          title: "WhatsApp reply received - automation stopped",
          metadata: { messageId: id, messageType: type, duplicatePhoneMatch: matches.rowCount! > 1 },
          ...SYSTEM_ACTOR,
        });
        if (lead.owner_id) {
          await db.query(
            `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, lead_id, href)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [
              workspaceId,
              lead.owner_id,
              "WhatsApp reply received",
              matches.rowCount! > 1 ? "Automation stopped for multiple leads sharing this number." : "Automation was switched to manual.",
              matches.rowCount! > 1 ? "warning" : "info",
              lead.id,
              `/leads/${lead.id}`,
            ],
          );
        }
        await onAgentEvent(db, { workspaceId, leadId: lead.id, event: "whatsapp_inbound", payload: { messageId: id } });
        // In every agent mode: the reply is real. onAgentEvent's handoff already cancelled the pending wakeups.
        // E3b-2a-2 rule 1: a follow-up reply (handed off by an earlier reply, conversation still open) is treated the same.
        const wasManaged = lead.agent_status === "active" || lead.agent_status === "paused" || (disposition === "matched" && (await isReplyFollowUp(db, lead.id, lead.agent_status)));
        if (disposition === "matched" && lead.owner_id && wasManaged) {
          await ensureReplyTask(db, workspaceId, { id: lead.id, owner_id: lead.owner_id, owner_name: lead.owner_name }, REPLY_TASK_TITLE);
        }
        // D4a: keyword labels in every mode; the AI step only for AI contacts in a non-off mode.
        if (disposition === "matched") {
          const mode = (await db.query<{ mode: AgentMode }>(`select mode from public.agent_settings where workspace_id = $1`, [workspaceId])).rows[0]?.mode ?? "off";
          if (keyword) {
            await applyReplyLabel(db, { workspaceId, leadId: lead.id, messageId: id, label: keyword, source: "keyword", status: "done" });
          } else if (hasText && wasManaged && mode !== "off") {
            await db.query(
              `update public.whatsapp_inbound_events set classification_status = 'pending', classification_next_at = now() where message_id = $1`,
              [id],
            );
          } else {
            await applyReplyLabel(db, { workspaceId, leadId: lead.id, messageId: id, label: "unclassified", source: "keyword", status: "skipped" });
          }
          // E3b-2a rule 1: a suggested reply for the owner (written by the worker once the label is known).
          await markReplyForDraft(db, { channel: "whatsapp", eventId: id, leadId: lead.id, eligible: hasText && wasManaged && mode !== "off" && Boolean(lead.owner_id) });
        }
      }

      if (matches.rowCount! > 1) {
        await db.query(
          `insert into public.admin_audit_events (actor_email, action, target_type, target_id, metadata)
           values ('system@whatsapp.local', 'whatsapp.inbound_ambiguous', 'phone', $1, $2)`,
          [phone, { messageId: id, matchCount: matches.rowCount }],
        );
      }
    });
  }
}
