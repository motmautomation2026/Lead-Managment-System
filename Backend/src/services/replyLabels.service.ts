/**
 * D4a: a reply's label and what it does (rule 4); D3: WhatsApp or email replies. Ids and labels
 * only: never the reply text, a quote of it, or anything derived from it beyond the label.
 */
import { z } from "zod";
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { AGENT_ACTOR_NAME } from "../agent/constants.js";
import { canTransition } from "../agent/status.js";
import type { AgentStatus } from "../agent/rules.js";
import type { LifecycleState } from "../domain/enums.js";
import {
  REPLY_LABELS,
  REPLY_TASK_TITLES,
  replyEffects,
  replyTaskTitle,
  type ReplyChannel,
  type ReplyLabel,
  type ReplyLabelSource,
} from "../agent/replyClassification.js";
import { cancelPendingWakeups } from "./agentWakeups.service.js";
import { addTimelineEvent } from "./timeline.service.js";
import { attributeReplyLabel } from "./messageFacts.service.js";
import { canReadReplies } from "./inboundReplies.service.js";

const AGENT_ACTOR = { actorId: null, actorName: AGENT_ACTOR_NAME, actorSource: "automation" as const };
const OPT_OUT_REASON = "Asked to stop on WhatsApp";
const EMAIL_STOP_REASON = "Asked to stop by email";

/** The event row of a reply: WhatsApp by message id, email by event id. */
const EVENTS = {
  whatsapp: { table: "public.whatsapp_inbound_events", key: "message_id", ref: "messageId" },
  email: { table: "public.email_inbound_events", key: "id", ref: "emailEventId" },
} as const;

export interface ReplyLabelInput {
  /** Default whatsapp. For email, `messageId` is the `email_inbound_events` id. */
  channel?: ReplyChannel;
  workspaceId: string;
  leadId: string;
  messageId: string;
  label: ReplyLabel;
  source: Exclude<ReplyLabelSource, "rep">;
  status: "done" | "failed" | "skipped";
  confidence?: number | null;
  cost?: { model: string; inputTokens: number; outputTokens: number; costUsd: number | null } | null;
}

/** Re-titles the contact's open reply task (if any); `other`/`unclassified` give it the channel's default title back. */
export async function retitleReplyTask(db: Queryable, leadId: string, label: ReplyLabel, channel: ReplyChannel = "whatsapp"): Promise<void> {
  await db.query(
    `update public.tasks set title = $3
      where lead_id = $1 and origin = 'agent' and status = 'open' and title = any($2::text[]) and title <> $3`,
    [leadId, REPLY_TASK_TITLES, replyTaskTitle(label, channel)],
  );
}

/**
 * Records the label on the event and applies its effects, inside the caller's
 * transaction. Effects are idempotent: opted_out stays opted_out, a stopped
 * agent stays stopped, the notification goes out only on the opt-out itself.
 */
export async function applyReplyLabel(db: Queryable, input: ReplyLabelInput): Promise<void> {
  const channel = input.channel ?? "whatsapp";
  const event = EVENTS[channel];
  await db.query(
    `update ${event.table}
        set reply_label = $2, reply_label_source = $3, reply_label_confidence = $4, classification_status = $5,
            classified_at = coalesce(classified_at, now()), classification_next_at = null,
            classification_model = coalesce($6, classification_model),
            classification_input_tokens = coalesce($7, classification_input_tokens),
            classification_output_tokens = coalesce($8, classification_output_tokens),
            classification_cost_usd = coalesce($9, classification_cost_usd)
      where ${event.key} = $1`,
    [
      input.messageId,
      input.label,
      input.source,
      input.confidence ?? null,
      input.status,
      input.cost?.model ?? null,
      input.cost?.inputTokens ?? null,
      input.cost?.outputTokens ?? null,
      input.cost?.costUsd ?? null,
    ],
  );
  const applied = await applyReplyEffects(db, { channel, workspaceId: input.workspaceId, leadId: input.leadId, messageId: input.messageId, label: input.label });
  await attributeReplyLabel(db, input.leadId, input.label);
  // other/unclassified keep the task's current title: a later "ok" must not hide an earlier "Wants to talk".
  if (applied && input.label !== "other" && input.label !== "unclassified") await retitleReplyTask(db, input.leadId, input.label, channel);
}

/**
 * A label's effects on the contact: opt out of the reply's channel (WhatsApp opted_out / email
 * unsubscribed, owner notified once) and stop the AI permanently. Never Do Not Contact. D3's
 * email unsubscribe request uses it too (`asked_to_stop`, `event` "email_unsubscribe").
 * Returns false when the contact is gone or merged.
 */
export async function applyReplyEffects(
  db: Queryable,
  input: { channel: ReplyChannel; workspaceId: string; leadId: string; messageId: string; label: ReplyLabel; event?: string; optOutReason?: string },
): Promise<boolean> {
  const ref = { [EVENTS[input.channel].ref]: input.messageId };
  const lead = (
    await db.query<{
      first_name: string | null;
      last_name: string | null;
      owner_id: string | null;
      agent_status: AgentStatus;
      agent_status_reason: string | null;
      lifecycle_state: LifecycleState;
      has_contact: boolean;
      nurture_long_term: boolean | null;
    }>(
      `select l.first_name, l.last_name, l.owner_id, l.agent_status, l.agent_status_reason, l.lifecycle_state,
              (l.email is not null or l.phone_e164 is not null) as has_contact, s.nurture_long_term
         from public.leads l left join public.agent_settings s on s.workspace_id = l.workspace_id
        where l.id = $1 and l.workspace_id = $2 and l.merged_into_lead_id is null
        for update of l`,
      [input.leadId, input.workspaceId],
    )
  ).rows[0];
  if (!lead) return false;

  const effects = replyEffects(input.label);
  if (effects.optOut) {
    const email = input.channel === "email";
    const reason = input.optOutReason ?? (email ? EMAIL_STOP_REASON : OPT_OUT_REASON);
    const status = email ? "unsubscribed" : "opted_out";
    const by = email ? "Email" : "WhatsApp";
    const changed = await db.query(
      `insert into public.lead_contact_channels (lead_id, channel, status, reason, updated_by_name)
       values ($1, $2, $3, $4, $5)
       on conflict (lead_id, channel) do update
         set status = excluded.status, reason = excluded.reason, updated_at = now(), updated_by = null, updated_by_name = excluded.updated_by_name
         where lead_contact_channels.status <> excluded.status
       returning lead_id`,
      [input.leadId, input.channel, status, reason, by],
    );
    if (changed.rowCount) {
      await addTimelineEvent(db, {
        leadId: input.leadId,
        kind: "system",
        title: email ? "Unsubscribed from email" : "whatsapp contactability: opted_out",
        detail: reason,
        actorId: null,
        actorName: by,
        actorSource: "automation",
        metadata: { ...ref, replyLabel: input.label },
      });
      if (lead.owner_id) {
        const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || "A contact";
        await db.query(
          `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, lead_id, href)
           values ($1, $2, $3, $4, 'warning', $5, $6)`,
          [
            input.workspaceId,
            lead.owner_id,
            email ? `${name} unsubscribed from email` : `${name} asked us to stop messaging on WhatsApp`,
            email
              ? "Email is now unsubscribed for this contact. Do Not Contact was not changed."
              : "WhatsApp is now opted out for this contact. Do Not Contact was not changed.",
            input.leadId,
            `/contacts/${input.leadId}`,
          ],
        );
      }
    }
  }

  const stop = effects.agentStopReason;
  const ctx = { lifecycleState: lead.lifecycle_state, nurtureLongTerm: Boolean(lead.nurture_long_term), statusReason: lead.agent_status_reason, hasContact: lead.has_contact };
  if (stop && canTransition(lead.agent_status, "stop", ctx).ok) {
    await db.query(`update public.leads set agent_status = 'stopped', agent_status_reason = $2, agent_status_changed_at = now() where id = $1`, [input.leadId, stop]);
    await addTimelineEvent(db, {
      leadId: input.leadId,
      kind: "automation",
      title: "AI Agent Stopped",
      ...AGENT_ACTOR,
      metadata: { agentStatusFrom: lead.agent_status, agentStatusTo: "stopped", reason: stop, event: input.event ?? "reply_label", ...ref },
    });
    await cancelPendingWakeups(db, input.leadId, stop);
  }
  return true;
}

/** A rep may pick any label except "unclassified" (that one means the system couldn't). */
export const replyLabelCorrectionSchema = z.object({ label: z.enum(REPLY_LABELS).exclude(["unclassified"]) }).strict();

/** The matched reply of this contact (its timeline row links them), locked; 404 otherwise. */
const CORRECTION_LOOKUP: Record<ReplyChannel, string> = {
  whatsapp: `select l.owner_id
         from public.leads l
         join public.whatsapp_inbound_events e on e.workspace_id = l.workspace_id and e.message_id = $3 and e.disposition = 'matched'
        where l.id = $1 and l.workspace_id = $2
          and exists (select 1 from public.timeline_events t
                       where t.lead_id = l.id and t.event_kind = 'whatsapp' and t.metadata->>'messageId' = e.message_id)
        for update of e`,
  email: `select l.owner_id
         from public.leads l
         join public.email_inbound_events e on e.workspace_id = l.workspace_id and e.id = $3 and e.kind = 'reply' and e.match_status = 'matched'
        where l.id = $1 and l.workspace_id = $2
          and exists (select 1 from public.timeline_events t
                       where t.lead_id = l.id and t.event_kind = 'email' and t.metadata->>'emailReplyId' = e.id::text)
        for update of e`,
};

/**
 * Rule 5: the owner or an admin changes a reply's label. Recorded (source rep, who,
 * when) and re-titles the open reply task; never undoes an opt-out or restarts a
 * permanently stopped AI, and never applies new effects. 404/403 like D2's read.
 */
export async function correctReplyLabel(
  db: Queryable,
  actor: Actor,
  workspaceId: string,
  leadId: string,
  messageId: string,
  label: ReplyLabel,
  channel: ReplyChannel = "whatsapp",
) {
  const row = (await db.query<{ owner_id: string | null }>(CORRECTION_LOOKUP[channel], [leadId, workspaceId, messageId])).rows[0];
  if (!row) throw new NotFoundError("Reply");
  if (!canReadReplies(actor, row.owner_id)) throw new ForbiddenError("Only the contact owner and admins can change a reply's label.");
  const event = EVENTS[channel];
  // A pending AI step is dropped: the rep's label wins.
  await db.query(
    `update ${event.table}
        set reply_label = $2, reply_label_source = 'rep', reply_label_confidence = null, label_corrected_by = $3, label_corrected_at = now(),
            classification_status = case when classification_status = 'pending' then 'done' else classification_status end,
            classification_next_at = null, classified_at = coalesce(classified_at, now())
      where ${event.key} = $1`,
    [messageId, label, actor.id],
  );
  await retitleReplyTask(db, leadId, label, channel);
  return { messageId, label, labelSource: "rep" as const, labelBy: actor.fullName };
}
