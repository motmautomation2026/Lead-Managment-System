/**
 * D4a: a WhatsApp reply's label and what it does (rule 4). Ids and labels only:
 * never the reply text, a quote of it, or anything derived from it beyond the label.
 */
import type { Queryable } from "../dto.js";
import { AGENT_ACTOR_NAME } from "../agent/constants.js";
import { canTransition } from "../agent/status.js";
import type { AgentStatus } from "../agent/rules.js";
import type { LifecycleState } from "../domain/enums.js";
import { REPLY_TASK_TITLES, replyEffects, replyTaskTitle, type ReplyLabel, type ReplyLabelSource } from "../agent/replyClassification.js";
import { cancelPendingWakeups } from "./agentWakeups.service.js";
import { addTimelineEvent } from "./timeline.service.js";

const AGENT_ACTOR = { actorId: null, actorName: AGENT_ACTOR_NAME, actorSource: "automation" as const };
const OPT_OUT_REASON = "Asked to stop on WhatsApp";

export interface ReplyLabelInput {
  workspaceId: string;
  leadId: string;
  messageId: string;
  label: ReplyLabel;
  source: Exclude<ReplyLabelSource, "rep">;
  status: "done" | "failed" | "skipped";
  confidence?: number | null;
  cost?: { model: string; inputTokens: number; outputTokens: number; costUsd: number | null } | null;
}

/** Re-titles the contact's open reply task (if any); `other`/`unclassified` give it the 4A title back. */
export async function retitleReplyTask(db: Queryable, leadId: string, label: ReplyLabel): Promise<void> {
  await db.query(
    `update public.tasks set title = $3
      where lead_id = $1 and origin = 'agent' and status = 'open' and title = any($2::text[]) and title <> $3`,
    [leadId, REPLY_TASK_TITLES, replyTaskTitle(label)],
  );
}

/**
 * Records the label on the event and applies its effects, inside the caller's
 * transaction. Effects are idempotent: opted_out stays opted_out, a stopped
 * agent stays stopped, the notification goes out only on the opt-out itself.
 */
export async function applyReplyLabel(db: Queryable, input: ReplyLabelInput): Promise<void> {
  await db.query(
    `update public.whatsapp_inbound_events
        set reply_label = $2, reply_label_source = $3, reply_label_confidence = $4, classification_status = $5,
            classified_at = coalesce(classified_at, now()), classification_next_at = null,
            classification_model = coalesce($6, classification_model),
            classification_input_tokens = coalesce($7, classification_input_tokens),
            classification_output_tokens = coalesce($8, classification_output_tokens),
            classification_cost_usd = coalesce($9, classification_cost_usd)
      where message_id = $1`,
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
  if (!lead) return;

  const effects = replyEffects(input.label);
  if (effects.optOutWhatsapp) {
    const changed = await db.query(
      `insert into public.lead_contact_channels (lead_id, channel, status, reason, updated_by_name)
       values ($1, 'whatsapp', 'opted_out', $2, 'WhatsApp')
       on conflict (lead_id, channel) do update
         set status = 'opted_out', reason = excluded.reason, updated_at = now(), updated_by = null, updated_by_name = 'WhatsApp'
         where lead_contact_channels.status <> 'opted_out'
       returning lead_id`,
      [input.leadId, OPT_OUT_REASON],
    );
    if (changed.rowCount) {
      await addTimelineEvent(db, {
        leadId: input.leadId,
        kind: "system",
        title: "whatsapp contactability: opted_out",
        detail: OPT_OUT_REASON,
        actorId: null,
        actorName: "WhatsApp",
        actorSource: "automation",
        metadata: { messageId: input.messageId, replyLabel: input.label },
      });
      if (lead.owner_id) {
        const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || "A contact";
        await db.query(
          `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, lead_id, href)
           values ($1, $2, $3, $4, 'warning', $5, $6)`,
          [
            input.workspaceId,
            lead.owner_id,
            `${name} asked us to stop messaging on WhatsApp`,
            "WhatsApp is now opted out for this contact. Do Not Contact was not changed.",
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
      metadata: { agentStatusFrom: lead.agent_status, agentStatusTo: "stopped", reason: stop, event: "reply_label", messageId: input.messageId },
    });
    await cancelPendingWakeups(db, input.leadId, stop);
  }

  // other/unclassified keep the task's current title: a later "ok" must not hide an earlier "Wants to talk".
  if (input.label !== "other" && input.label !== "unclassified") await retitleReplyTask(db, input.leadId, input.label);
}
