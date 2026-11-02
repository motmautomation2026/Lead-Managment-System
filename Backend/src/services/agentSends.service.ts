import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import type { PipelineStage } from "../domain/enums.js";
import { AGENT_ACTOR_NAME } from "../agent/constants.js";
import { composeOutgoing } from "../agent/composeMessage.js";
import type { AgentStatus } from "../agent/rules.js";
import { PermanentProviderError, ProviderDeferredError, SendCancelledError } from "../providers/provider-errors.js";
import type { WhatsAppAttachment, WhatsAppSendSource } from "../providers/baileys.manager.js";
import { ASSET_GONE_REASON, attachmentFileName, type AttachmentIssue } from "../agent/assetRules.js";
import { AGENT_ASSETS_BUCKET } from "./knowledgeLibrary.service.js";
import { sendWhatsApp, wasSentForSource } from "../providers/whatsapp.provider.js";
import { cancelPendingWakeups } from "./agentWakeups.service.js";
import { createTask } from "./tasks.service.js";
import { addTimelineEvent } from "./timeline.service.js";
import { endOfIstDay } from "./whatsapp-inbound.service.js";
import { agentSendRecheck, recordAgentSendOutcome, type AgentSendOutcome } from "./agentSendState.service.js";

export { agentSendRecheck, recordAgentSendOutcome };

/**
 * E2 Live mode: the AI's real sends and executed actions. WhatsApp sends are claimed
 * from agent_decisions (send_status queued) and go through performSend → decideSend;
 * emails are rows in email_outbound_messages (source 'agent') sent by runEmailOutbound.
 * Both re-check the contact (agentSendRecheck) right before the provider call, inside
 * the channel's claim step. Only the worker sends.
 */

const AGENT_ACTOR = { actorId: null, actorName: AGENT_ACTOR_NAME, actorSource: "automation" as const };
const MAX_SEND_ATTEMPTS = 3;
const RETRY_MS = 5 * 60_000;
const BATCH = 5;
export const HANDOFF_TASK_TITLE = "AI handed off — please follow up";


// --- WhatsApp: the claim loop -------------------------------------------------------

interface ClaimedSend {
  id: string;
  workspace_id: string;
  lead_id: string;
  message_body: string;
  /** The rules-checked assets (at most 1 on WhatsApp). */
  asset_ids: string[] | null;
  send_attempts: number;
  send_claimed_at: Date;
}

export type WhatsAppSender = (
  workspaceId: string,
  input: { source: WhatsAppSendSource; to: string; body: string; attachment?: WhatsAppAttachment },
) => Promise<{ providerMessageId: string; attachmentMissing?: boolean }>;

export interface AgentSendDeps {
  dryRun?: boolean;
  /** Default: the workspace's Baileys manager (sendWhatsApp). Tests inject a manager with a fake socket. */
  send?: WhatsAppSender;
  /** Tests: only these workspaces. */
  workspaceIds?: string[];
}

/**
 * Worker tick (behind AGENT_RUNNER_ENABLED): claims up to 5 queued AI WhatsApp sends
 * (SKIP LOCKED; a `sending` row is reclaimed after 15 min; send_claimed_at is the claim
 * token) and sends each through performSend. No transaction is held across the send.
 */
export async function runAgentSends(enabled: boolean, deps: AgentSendDeps = {}): Promise<{ id: string; result: string }[]> {
  if (!enabled) return [];
  const claimed = (
    await pool.query<ClaimedSend>(
      `update public.agent_decisions
          set send_status = 'sending', send_claimed_at = date_trunc('milliseconds', now()), send_next_at = now() + interval '15 minutes'
        where id in (
          select id from public.agent_decisions
           where action = 'send_whatsapp' and send_status in ('queued', 'sending') and send_next_at <= now()
             and ($1::uuid[] is null or workspace_id = any($1::uuid[]))
           order by send_next_at
           limit $2
           for update skip locked)
        returning id, workspace_id, lead_id, message_body, asset_ids, send_attempts, send_claimed_at`,
      [deps.workspaceIds ?? null, BATCH],
    )
  ).rows;
  const results: { id: string; result: string }[] = [];
  for (const row of claimed) {
    const result = await processAgentWhatsApp(row, deps).catch((error: { code?: string; name?: string }) => {
      // Codes only. The row is reclaimed after 15 min.
      console.error(`[agent] WhatsApp send ${row.id} failed unexpectedly: ${error?.code ?? error?.name ?? "unknown error"}`);
      return "error";
    });
    results.push({ id: row.id, result });
  }
  return results;
}

/** Writes the outcome only while the claim is still ours. */
async function settle(row: ClaimedSend, outcome: AgentSendOutcome): Promise<string> {
  await withTransaction(async (db) => {
    const ours = await db.query(`select 1 from public.agent_decisions where id = $1 and send_status = 'sending' and send_claimed_at = $2 for update`, [row.id, row.send_claimed_at]);
    if (ours.rowCount) await recordAgentSendOutcome(db, row.id, outcome);
  });
  return outcome.kind === "sent" && outcome.dryRun ? "dry_run" : outcome.kind;
}

async function processAgentWhatsApp(row: ClaimedSend, deps: AgentSendDeps): Promise<string> {
  const source: WhatsAppSendSource = { type: "agent", id: row.id };
  // Crash recovery: the message went out but the decision wasn't marked.
  const already = await pool.query<{ message_id: string }>(`select message_id from public.whatsapp_outbound_messages where agent_decision_id = $1 and status = 'sent'`, [row.id]);
  const asset = await loadAsset(row);
  // The message carried its document (one message: document + caption), unless the file was missing then.
  const sentWith = (missing = false): AgentSendOutcome & { kind: "sent" } => ({
    kind: "sent",
    providerMessageId: null,
    dryRun: false,
    sentAssets: asset.attachment && !missing ? [{ id: asset.attachment.assetId, title: asset.attachment.title }] : [],
    attachmentIssues: [...asset.issues, ...(missing && asset.attachment ? [{ assetId: asset.attachment.assetId, title: asset.attachment.title, reason: MISSING_FILE }] : [])],
  });
  if (already.rows[0]) return settle(row, { ...sentWith(), providerMessageId: already.rows[0].message_id });

  if (deps.dryRun) {
    const check = await withTransaction((db) => agentSendRecheck(db, row.id, "whatsapp"));
    if ("cancel" in check) return settle(row, { kind: "cancelled", reason: check.cancel });
    if ("defer" in check) return settle(row, { kind: "deferred", until: check.defer, reason: check.reason });
    return settle(row, { kind: "sent", providerMessageId: null, dryRun: true });
  }

  const message = await composeWhatsApp(row);
  if (!message.phone) return settle(row, { kind: "cancelled", reason: "The contact has no WhatsApp number." });
  try {
    const sent = await (deps.send ?? sendWhatsApp)(row.workspace_id, {
      source,
      to: message.phone,
      body: message.text,
      ...(asset.attachment ? { attachment: asset.attachment.file } : {}),
    });
    return settle(row, { ...sentWith(sent.attachmentMissing), providerMessageId: sent.providerMessageId });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof ProviderDeferredError) return settle(row, { kind: "deferred", until: new Date(Date.now() + error.retryAfterMs), reason });
    if (error instanceof SendCancelledError) return settle(row, { kind: "cancelled", reason });
    if (error instanceof PermanentProviderError) return settle(row, { kind: "failed", reason });
    if (await wasSentForSource(pool, source)) return settle(row, sentWith());
    const attempts = row.send_attempts + 1;
    if (attempts >= MAX_SEND_ATTEMPTS) return settle(row, { kind: "failed", reason: `Gave up after ${attempts} attempts: ${reason}` });
    await pool.query(`update public.agent_decisions set send_attempts = $3 where id = $1 and send_claimed_at = $2`, [row.id, row.send_claimed_at, attempts]);
    return settle(row, { kind: "deferred", until: new Date(Date.now() + RETRY_MS), reason: `Temporary error, will retry: ${reason}` });
  }
}

const MISSING_FILE = "The file was missing from storage.";

/**
 * E2g rule 6: the decision's asset as a WhatsApp document (file name = title + extension). An asset
 * deleted or turned off since the decision is left out and recorded; the text still goes.
 */
async function loadAsset(row: ClaimedSend): Promise<{ attachment: { assetId: string; title: string; file: WhatsAppAttachment } | null; issues: AttachmentIssue[] }> {
  const id = row.asset_ids?.[0];
  if (!id) return { attachment: null, issues: [] };
  const asset = (
    await pool.query<{ title: string; storage_path: string; file_name: string | null; mime_type: string | null; is_active: boolean }>(
      `select title, storage_path, file_name, mime_type, is_active from public.agent_assets where id = $1 and workspace_id = $2`,
      [id, row.workspace_id],
    )
  ).rows[0];
  if (!asset?.is_active) return { attachment: null, issues: [{ assetId: id, title: asset?.title ?? null, reason: ASSET_GONE_REASON }] };
  return {
    attachment: {
      assetId: id,
      title: asset.title,
      file: {
        bucket: AGENT_ASSETS_BUCKET,
        storagePath: asset.storage_path,
        fileName: attachmentFileName(asset.title, asset.file_name),
        mimeType: asset.mime_type || "application/octet-stream",
      },
    },
    issues: [],
  };
}

/** The AI's text with the owner's signature and (first AI WhatsApp only) the opt-out line; performSend's safety rules add nothing twice. */
async function composeWhatsApp(row: ClaimedSend): Promise<{ text: string; phone: string | null }> {
  const info = (
    await pool.query<{ phone_e164: string | null; owner_name: string | null; company_name: string; email_opt_out_text: string; whatsapp_opt_out_text: string; sent_before: boolean }>(
      `select l.phone_e164, o.full_name as owner_name, coalesce(nullif(trim(s.company_display_name), ''), w.name) as company_name,
              s.email_opt_out_text, s.whatsapp_opt_out_text,
              exists (select 1 from public.agent_decisions p where p.lead_id = l.id and p.action = 'send_whatsapp' and p.outcome = 'sent') as sent_before
         from public.leads l
         join public.workspaces w on w.id = l.workspace_id
         join public.agent_settings s on s.workspace_id = l.workspace_id
         left join public.profiles o on o.id = l.owner_id
        where l.id = $1`,
      [row.lead_id],
    )
  ).rows[0]!;
  const composed = composeOutgoing(
    { action: "send_whatsapp", body: row.message_body, assetIds: [], nextWakeInDays: 1, reasoning: "" },
    { ownerName: info.owner_name ?? "The team", companyName: info.company_name, settings: info, isFirstWhatsApp: !info.sent_before },
  );
  return { text: composed.text, phone: info.phone_e164 };
}

// --- Executed decisions (rule 8) -----------------------------------------------------

/** One open AI handoff task per contact, for the owner, due 23:59 IST today. The reason goes on the timeline row. */
export async function executeHandoff(db: Queryable, workspaceId: string, leadId: string, decisionId: string, reason: string): Promise<void> {
  const lead = (await db.query<{ owner_id: string | null; owner_name: string | null }>(
    `select l.owner_id, o.full_name as owner_name from public.leads l left join public.profiles o on o.id = l.owner_id where l.id = $1`,
    [leadId],
  )).rows[0];
  const open = await db.query(`select 1 from public.tasks where lead_id = $1 and origin = 'agent' and status = 'open' and title = $2 limit 1`, [leadId, HANDOFF_TASK_TITLE]);
  if (!open.rowCount && lead?.owner_id) {
    await createTask(db, null, workspaceId, {
      leadId,
      ownerId: lead.owner_id,
      ownerName: lead.owner_name,
      type: "follow_up",
      title: HANDOFF_TASK_TITLE,
      dueAt: endOfIstDay().toISOString(),
      origin: "agent",
    });
  }
  await setAgentStatus(db, leadId, "handed_off", "ai_handoff");
  await addTimelineEvent(db, { leadId, kind: "automation", title: `AI handed off: ${reason}`.slice(0, 300), ...AGENT_ACTOR, metadata: { decisionId } });
}

export async function executeStop(db: Queryable, leadId: string, decisionId: string, reason: string): Promise<void> {
  await setAgentStatus(db, leadId, "stopped", reason);
  await addTimelineEvent(db, { leadId, kind: "automation", title: "AI stopped", detail: reason.replace(/_/g, " "), ...AGENT_ACTOR, metadata: { decisionId } });
}

/** Within the allow-list only (rules.ts already refused anything else), through updateLead. */
export async function executeStageChange(db: Queryable, workspaceId: string, leadId: string, decisionId: string, stage: PipelineStage): Promise<void> {
  const { updateLead } = await import("./leads.service.js");
  await updateLead(db, null, workspaceId, leadId, { pipelineStage: stage });
  await addTimelineEvent(db, { leadId, kind: "automation", title: `AI moved stage to ${stage.replace(/_/g, " ")}`, ...AGENT_ACTOR, metadata: { decisionId } });
}

async function setAgentStatus(db: Queryable, leadId: string, to: AgentStatus, reason: string) {
  await db.query(`update public.leads set agent_status = $2, agent_status_reason = $3, agent_status_changed_at = now() where id = $1`, [leadId, to, reason]);
  await cancelPendingWakeups(db, leadId, reason);
}
