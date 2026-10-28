import type { Queryable } from "../dto.js";
import type { LifecycleState } from "../domain/enums.js";
import { AGENT_ACTOR_NAME } from "../agent/constants.js";
import { effectiveMode, sendRecheck, type LiveScope, type SendRecheck } from "../agent/liveMode.js";
import type { AgentRuleSettings, AgentStatus } from "../agent/rules.js";
import { addTimelineEvent } from "./timeline.service.js";

/**
 * E2: the AI send's re-check (rule 5) and writing a send's outcome back to its decision.
 * No provider imports, so the channel senders (performSend, processEmail) can use it.
 */

const AGENT_ACTOR = { actorId: null, actorName: AGENT_ACTOR_NAME, actorSource: "automation" as const };

// --- The send-time re-check ---------------------------------------------------------

interface RecheckRow extends AgentRuleSettings {
  decision_created_at: Date;
  lead_id: string;
  agent_status: AgentStatus;
  lifecycle_state: LifecycleState;
  email: string | null;
  phone_e164: string | null;
  agent_live_test: boolean;
  lead_created_at: Date;
  mode: "off" | "shadow" | "live";
  live_scope: LiveScope;
  live_since: Date | null;
  email_status: string | null;
  whatsapp_status: string | null;
  phone_status: string | null;
  last_reply_at: Date | null;
  imap_last_success_at: Date | null;
  has_run: boolean;
  touch_count: number;
  last_touch_at: Date | null;
  recent_touches: Date[];
  last_rep_activity_at: Date | null;
}

/**
 * Rule 5 for one decision, with the decision and lead rows locked: run inside the
 * channel's short claim transaction, immediately before the provider call.
 */
export async function agentSendRecheck(
  db: Queryable,
  decisionId: string,
  channel: "email" | "whatsapp",
  now = new Date(),
): Promise<SendRecheck & { phoneE164?: string | null; email?: string | null }> {
  const row = (
    await db.query<RecheckRow>(
      // s.* first: its created_at must not shadow the decision's.
      `select s.*, d.created_at as decision_created_at, d.lead_id, l.agent_status, l.lifecycle_state, l.email, l.phone_e164, l.agent_live_test,
              l.created_at as lead_created_at,
              (select status from public.lead_contact_channels where lead_id = l.id and channel = 'email') as email_status,
              (select status from public.lead_contact_channels where lead_id = l.id and channel = 'whatsapp') as whatsapp_status,
              (select status from public.lead_contact_channels where lead_id = l.id and channel = 'phone') as phone_status,
              -- A matched reply on ANY channel (WhatsApp, or an email reply / unsubscribe).
              greatest(
                (select max(received_at) from public.whatsapp_inbound_events where lead_id = l.id),
                (select max(received_at) from public.email_inbound_events
                  where lead_id = l.id and match_status = 'matched' and kind in ('reply', 'unsubscribe'))) as last_reply_at,
              (select last_success_at from public.email_imap_state where workspace_id = d.workspace_id) as imap_last_success_at,
              exists (select 1 from public.workflow_runs where lead_id = l.id and status in ('running', 'waiting', 'paused')) as has_run,
              -- Real sends only (rule 6), not this decision.
              (select count(*)::int from public.agent_decisions where lead_id = l.id and outcome = 'sent' and id <> d.id) as touch_count,
              (select max(sent_at) from public.agent_decisions where lead_id = l.id and outcome = 'sent' and id <> d.id) as last_touch_at,
              coalesce((select array_agg(sent_at) from public.agent_decisions
                         where lead_id = l.id and outcome = 'sent' and id <> d.id and sent_at > now() - interval '7 days'), '{}') as recent_touches,
              greatest(
                (select max(created_at) from public.calls where lead_id = l.id),
                (select max(created_at) from public.lead_notes where lead_id = l.id)) as last_rep_activity_at
         from public.agent_decisions d
         join public.leads l on l.id = d.lead_id and l.workspace_id = d.workspace_id
         join public.agent_settings s on s.workspace_id = d.workspace_id
        where d.id = $1
        for update of d, l`,
      [decisionId],
    )
  ).rows[0];
  if (!row) return { cancel: "The decision or contact no longer exists." };
  const result = sendRecheck({
    now,
    channel,
    decisionCreatedAt: row.decision_created_at,
    mode: effectiveMode(row, { agentLiveTest: row.agent_live_test, createdAt: row.lead_created_at }),
    lead: { agentStatus: row.agent_status, lifecycleState: row.lifecycle_state, email: row.email, phoneE164: row.phone_e164 },
    contactability: { email: row.email_status, whatsapp: row.whatsapp_status, phone: row.phone_status },
    nurtureLongTerm: row.nurture_long_term,
    lastReplyAt: row.last_reply_at,
    imapLastSuccessAt: row.imap_last_success_at,
    hasActiveWorkflowRun: row.has_run,
    settings: row,
    realTouchCount: row.touch_count,
    lastRealTouchAt: row.last_touch_at,
    recentRealTouchTimes: row.recent_touches,
    lastRepActivityAt: row.last_rep_activity_at,
  });
  return { ...result, phoneE164: row.phone_e164, email: row.email };
}

// --- Writing the outcome back to the decision ----------------------------------------

export type AgentSendOutcome =
  | { kind: "sent"; providerMessageId: string | null; dryRun: boolean }
  | { kind: "deferred"; until: Date; reason: string }
  | { kind: "cancelled"; reason: string }
  | { kind: "failed"; reason: string };

/** Records a send outcome on the decision (and on a real send: touches + timeline; on failure: the owner is told once). */
export async function recordAgentSendOutcome(db: Queryable, decisionId: string, outcome: AgentSendOutcome): Promise<void> {
  const d = (
    await db.query<{ lead_id: string; workspace_id: string; action: string; message_subject: string | null; send_status: string | null }>(
      `select lead_id, workspace_id, action, message_subject, send_status from public.agent_decisions where id = $1 for update`,
      [decisionId],
    )
  ).rows[0];
  // Already final (e.g. a reclaimed row): never record twice.
  if (!d || ["sent", "failed", "cancelled", "dry_run"].includes(d.send_status ?? "")) return;

  if (outcome.kind === "sent" && outcome.dryRun) {
    await db.query(`update public.agent_decisions set send_status = 'dry_run', send_error = null where id = $1`, [decisionId]);
    console.log(`[agent] decision ${decisionId}: DRY RUN, ${d.action} not sent.`);
  } else if (outcome.kind === "sent") {
    await db.query(
      `update public.agent_decisions set send_status = 'sent', outcome = 'sent', sent_at = now(), provider_message_id = $2, send_error = null where id = $1`,
      [decisionId, outcome.providerMessageId],
    );
    await db.query(`update public.leads set agent_touch_count = agent_touch_count + 1, agent_last_touch_at = now(), last_activity_at = now() where id = $1`, [d.lead_id]);
    await addTimelineEvent(db, {
      leadId: d.lead_id,
      kind: "automation",
      title: d.action === "send_email" ? `AI sent email: ${d.message_subject ?? ""}`.slice(0, 300) : "AI sent WhatsApp",
      ...AGENT_ACTOR,
      metadata: { decisionId, providerMessageId: outcome.providerMessageId },
    });
  } else if (outcome.kind === "deferred") {
    await db.query(`update public.agent_decisions set send_status = 'queued', send_next_at = $2, send_error = $3, send_claimed_at = null where id = $1`, [
      decisionId,
      outcome.until,
      outcome.reason,
    ]);
  } else if (outcome.kind === "cancelled") {
    await db.query(`update public.agent_decisions set send_status = 'cancelled', cancel_reason = $2 where id = $1`, [decisionId, outcome.reason]);
    console.log(`[agent] decision ${decisionId}: send cancelled (${outcome.reason}).`);
  } else {
    await db.query(`update public.agent_decisions set send_status = 'failed', send_error = $2 where id = $1`, [decisionId, outcome.reason.slice(0, 1000)]);
    await db.query(
      `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, lead_id, href)
       select l.workspace_id, l.owner_id, $2, $3, 'warning', l.id, '/contacts/' || l.id
         from public.leads l where l.id = $1 and l.owner_id is not null`,
      [d.lead_id, `AI message to ${await leadName(db, d.lead_id)} failed`.slice(0, 300), outcome.reason.slice(0, 300)],
    );
  }
}

async function leadName(db: Queryable, leadId: string) {
  return (await db.query<{ name: string }>(`select concat_ws(' ', first_name, nullif(last_name, '')) as name from public.leads where id = $1`, [leadId])).rows[0]?.name ?? "a contact";
}
