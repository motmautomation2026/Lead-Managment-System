import "./workerRole.js"; // must stay first: sets the pool role before db.js loads
import { pool, withTransaction } from "./db.js";
import { workerEnv as env } from "./workerEnv.js";
import * as automationService from "./services/automation.service.js";
import { claimQueuedProposalWhatsappSends, processQueuedProposalWhatsappSend } from "./services/proposalSending.service.js";
import { claimQueuedMeetingWhatsappSends, processQueuedMeetingWhatsappSend } from "./services/meetingScheduledNotification.service.js";
import { renderTemplate } from "./domain/templateRenderer.js";
import { htmlToWhatsAppText } from "./domain/htmlToWhatsAppText.js";
import { queueEmailForAction, runEmailOutbound } from "./services/emailOutbound.service.js";
import { runEmailInbound } from "./services/emailInbound.service.js";
import { sendWhatsApp } from "./providers/whatsapp.provider.js";
import type { WorkflowStepAction } from "./domain/enums.js";
import { baileysRegistry } from "./providers/baileys-registry.js";
import { PermanentProviderError, ProviderDeferredError } from "./providers/provider-errors.js";
import { runKnowledgeIngestion } from "./services/knowledgeIngestion.service.js";
import { createOpenAIDecisionModel, getDefaultEmbedder } from "./providers/openai.provider.js";
import { runAgentTick } from "./services/agentRunner.service.js";
import { runReplyClassification } from "./services/replyClassifier.service.js";
import { runCompanySweep } from "./services/companies.service.js";
import { runDealSweep } from "./services/deals.service.js";

/**
 * The automation executor: polls for due scheduled_actions and dispatches
 * them. This file is deliberately thin — every business decision
 * (eligibility, retry/backoff, next-step scheduling, timeline logging)
 * already lives in automation.service.ts and is reused as-is; this loop
 * just calls those functions in-process.
 */

const MESSAGE_ACTION_TYPES: WorkflowStepAction[] = ["send_email", "send_whatsapp"];

interface SendOutcome {
  outcome: "success";
  providerMessageId: string;
}

async function dispatchMessage(ctx: automationService.ActionContext): Promise<SendOutcome> {
  if (!ctx.template) {
    throw new Error("No template resolved for a message action that passed eligibility (invariant violation).");
  }

  const rendered = renderTemplate(ctx.template, ctx.lead, ctx.meeting ?? undefined);
  if (rendered.unknownTokens.length > 0) {
    console.warn(
      `[worker] Template "${ctx.template.name}" (action ${ctx.action.id}) has unrecognized token(s): ${rendered.unknownTokens.join(", ")} — sent as literal text.`,
    );
  }

  // E1b: the email goes through the outbound queue (which also handles dry run); this step
  // waits (deferrals never burn attempts) until that email is sent or has failed.
  if (ctx.action.actionType === "send_email") {
    if (!ctx.lead.email) throw new Error("Eligible send_email action has no lead email (invariant violation).");
    const email = await queueEmailForAction({
      workspaceId: ctx.workspaceId,
      sourceId: ctx.action.id,
      leadId: ctx.lead.id,
      to: ctx.lead.email,
      subject: rendered.subject?.trim() || ctx.template.name,
      html: rendered.body,
      attachments: ctx.template.attachments.map((a) => ({ bucket: "template-attachments", path: a.storagePath, fileName: a.fileName, mimeType: a.mimeType, size: null })),
    });
    if (email.status === "sent") return { outcome: "success", providerMessageId: email.message_id ?? (email.dry_run ? "DRY_RUN" : email.id) };
    if (email.status === "failed") throw new PermanentProviderError(email.last_error ?? "The email could not be sent.");
    throw new ProviderDeferredError(email.last_error ?? "Email queued.", Math.max(60_000, email.next_attempt_at.getTime() - Date.now()));
  }

  if (env.WORKER_DRY_RUN) {
    console.log(
      `[worker] DRY RUN — would send ${ctx.action.actionType} to lead ${ctx.lead.id}:\n${
        rendered.subject ? `Subject: ${rendered.subject}\n` : ""
      }${rendered.body}`,
    );
    return { outcome: "success", providerMessageId: "DRY_RUN" };
  }

  if (!ctx.lead.phoneE164) throw new PermanentProviderError("Eligible WhatsApp action has no normalized phone number.");
  const whatsappText = htmlToWhatsAppText(rendered.body);
  const attachment = ctx.template.attachments[0];
  const result = await sendWhatsApp(ctx.workspaceId, {
    source: { type: "scheduled_action", id: ctx.action.id },
    to: ctx.lead.phoneE164,
    body: whatsappText,
    ...(attachment
      ? { attachment: { storagePath: attachment.storagePath, fileName: attachment.fileName, mimeType: attachment.mimeType, bucket: "template-attachments" } }
      : {}),
  });
  return { outcome: "success", providerMessageId: result.providerMessageId };
}

async function processAction(ctx: automationService.ActionContext): Promise<void> {
  if (!ctx.eligibility.ok) {
    await withTransaction((client) => automationService.skipAction(client, ctx.action.id, ctx.eligibility.reason ?? "Not eligible."));
    return;
  }

  if (!MESSAGE_ACTION_TYPES.includes(ctx.action.actionType)) {
    await withTransaction((client) => automationService.runInternalAction(client, ctx.action.id));
    return;
  }

  try {
    const result = await dispatchMessage(ctx);
    await withTransaction((client) => automationService.recordActionResult(client, ctx.action.id, result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ProviderDeferredError) {
      await withTransaction((client) =>
        automationService.recordActionResult(client, ctx.action.id, {
          outcome: "deferred",
          error: message,
          retryAt: new Date(Date.now() + err.retryAfterMs),
        }),
      );
      return;
    }
    console.error(`[worker] Send failed for action ${ctx.action.id} (${ctx.action.actionType}): ${message}`);
    await withTransaction((client) =>
      automationService.recordActionResult(client, ctx.action.id, {
        outcome: "failure",
        error: message,
        retryable: !(err instanceof PermanentProviderError),
      }),
    );
  }
}

async function tick(): Promise<void> {
  const claimed = await withTransaction((client) => automationService.claimDueActions(client, env.WORKER_BATCH_SIZE));
  if (claimed.length > 0) {
    console.log(`[worker] Claimed ${claimed.length} due action(s).`);
    // Each claimed action owns its own DB transaction and provider call, with
    // no shared mutable state between them, so processing the batch
    // concurrently is safe — and avoids one slow/hung send stalling the rest
    // of the batch behind it.
    await Promise.allSettled(
      claimed.map((ctx) =>
        processAction(ctx).catch((err) => {
          console.error(`[worker] Unexpected error processing action ${ctx.action.id}:`, err);
        }),
      ),
    );
  }

  // E1b: every email (workflow steps, proposals, meetings, tests), one per workspace per tick.
  const emails = await runEmailOutbound({ dryRun: env.WORKER_DRY_RUN });
  if (emails.length > 0) console.log(`[worker] Emails: ${emails.join(", ")}.`);

  // D3: read one due workspace's mailbox (read-only) for replies, bounces and unsubscribes.
  const inbound = await runEmailInbound({ pollSeconds: env.EMAIL_IMAP_POLL_SECONDS }).catch((err: { code?: string; name?: string }) => {
    console.error(`[worker] Email inbound failed: ${err?.code ?? err?.name ?? "unknown error"}`);
    return null;
  });
  if (inbound?.processed) console.log(`[worker] Email inbound ${inbound.workspaceId}: ${JSON.stringify(inbound.kinds)}.`);

  const queuedProposals = await withTransaction((client) => claimQueuedProposalWhatsappSends(client, env.WORKER_BATCH_SIZE));
  if (queuedProposals.length > 0) {
    console.log(`[worker] Claimed ${queuedProposals.length} queued proposal WhatsApp send(s).`);
    await Promise.allSettled(
      queuedProposals.map((row) =>
        processQueuedProposalWhatsappSend(row).catch((err) => {
          console.error(`[worker] Unexpected error processing proposal WhatsApp send ${row.id}:`, err);
        }),
      ),
    );
  }

  const queuedMeetings = await withTransaction((client) => claimQueuedMeetingWhatsappSends(client, env.WORKER_BATCH_SIZE));
  if (queuedMeetings.length > 0) {
    console.log(`[worker] Claimed ${queuedMeetings.length} queued meeting WhatsApp send(s).`);
    await Promise.allSettled(
      queuedMeetings.map((row) =>
        processQueuedMeetingWhatsappSend(row).catch((err) => {
          console.error(`[worker] Unexpected error processing meeting WhatsApp send ${row.id}:`, err);
        }),
      ),
    );
  }

  // Knowledge-base ingestion: at most 2 documents per tick (extraction and
  // embedding are the slow part, done outside any transaction).
  const ingested = await runKnowledgeIngestion({ embedder: getDefaultEmbedder() });
  for (const { id, outcome } of ingested) console.log(`[worker] Knowledge document ${id}: ${outcome}.`);

  // CRM v2: link up to 200 unchecked contacts to companies (backfill + inline-failure safety net).
  if (env.CRM_COMPANY_SWEEP_ENABLED) {
    // Codes only: a pg message can quote company names.
    const swept = await runCompanySweep().catch((err: { code?: string; name?: string }) => {
      console.error(`[worker] Company sweep failed: ${err?.code ?? err?.name ?? "unknown error"}`);
      return null;
    });
    if (swept && swept.processed > 0) console.log(`[worker] Company sweep: ${swept.processed} contact(s), ${swept.created} created, ${swept.linked} linked, ${swept.none} without company, ${swept.failed} failed.`);
  }

  // CRM v2: attach up to 100 contacts' unlinked meetings/proposals to deals (backfill + inline-failure safety net).
  if (env.CRM_DEAL_SWEEP_ENABLED) {
    const swept = await runDealSweep().catch((err: { code?: string; name?: string }) => {
      console.error(`[worker] Deal sweep failed: ${err?.code ?? err?.name ?? "unknown error"}`);
      return null;
    });
    if (swept && swept.processed + swept.failed > 0) console.log(`[worker] Deal sweep: ${swept.processed} contact(s), ${swept.created} deal(s) created, ${swept.attachedMeetings} meeting(s) and ${swept.attachedProposals} proposal(s) attached, ${swept.failed} failed.`);
  }

  // D4a: label WhatsApp replies that matched no keyword, behind AGENT_RUNNER_ENABLED.
  const labelled = await runReplyClassification(env.AGENT_RUNNER_ENABLED, { model: decisionModel }).catch((err: { code?: string; name?: string }) => {
    console.error(`[worker] Reply classification failed: ${err?.code ?? err?.name ?? "unknown error"}`);
    return [];
  });
  if (labelled.length) console.log(`[worker] Reply classification: ${labelled.length} reply(ies).`);

  // AI agent (shadow drafts only), behind AGENT_RUNNER_ENABLED; after all other work.
  await runAgentTick(env.AGENT_RUNNER_ENABLED, {
    model: decisionModel,
    embedder: getDefaultEmbedder(),
  });
}

const decisionModel = createOpenAIDecisionModel();

let stopped = false;

async function loop(): Promise<void> {
  while (!stopped) {
    await tick().catch((err) => console.error("[worker] Poll tick failed:", err));
    // Every tick (one cheap query), so a Settings pairing request starts its manager within a poll interval.
    await baileysRegistry.ensureManagers().catch((err) => console.error("[worker] WhatsApp manager scan failed:", err));
    if (stopped) break;
    await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_INTERVAL_MS));
  }
}

console.log(
  `Northbeam CRM automation worker starting (poll interval ${env.WORKER_POLL_INTERVAL_MS}ms, batch size ${env.WORKER_BATCH_SIZE}, dry run ${env.WORKER_DRY_RUN}, AI agent runner ${env.AGENT_RUNNER_ENABLED ? "on (shadow only)" : "off"}).`,
);
void baileysRegistry
  .ensureManagers()
  .then(() => loop())
  .catch(async (error) => {
    console.error("Automation worker failed to initialize per-workspace WhatsApp sessions:", error);
    await baileysRegistry.stopAll().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down worker...`);
  stopped = true;
  try {
    await baileysRegistry.stopAll();
    await pool.end();
  } catch (err) {
    console.error("[worker] Error closing database pool during shutdown:", err);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
