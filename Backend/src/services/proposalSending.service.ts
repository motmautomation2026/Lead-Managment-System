import { randomUUID } from "node:crypto";
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import { DoNotContactError, NotFoundError, ValidationError } from "../errors.js";
import { getLeadRowOr404, type LeadRow } from "./leads.service.js";
import { createProposal, getProposalOr404, getProposalRowOr404, tryAdvanceToSent, type ProposalRow } from "./proposals.service.js";
import { renderTemplate, type TemplateRenderLead } from "../domain/templateRenderer.js";
import { htmlToWhatsAppText } from "../domain/htmlToWhatsAppText.js";
import { enqueueEmail } from "./emailOutbound.service.js";
import { sendWhatsApp, wasSentForSource } from "../providers/whatsapp.provider.js";
import { ProviderDeferredError } from "../providers/provider-errors.js";
import { supabaseAdmin } from "../supabaseAdmin.js";

/**
 * Orchestrates the one-click "Send proposal" flow: create the proposal and queue
 * it on both channels. Only the worker sends: the email through the outbound
 * email queue (emailOutbound.service.ts, E1b), WhatsApp through
 * claimQueuedProposalWhatsappSends/processQueuedProposalWhatsappSend below.
 */

const PROPOSAL_DOCUMENTS_BUCKET = "proposal-documents";
const DOCUMENT_LINK_TTL_SECONDS = 300;
const PROPOSAL_WHATSAPP_MAX_DEFERRAL_MS = 72 * 60 * 60 * 1000;

function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-150) || "file";
}

interface TemplateRow {
  id: string;
  name: string;
  channel: "email" | "whatsapp";
  subject: string | null;
  body: string;
  is_active: boolean;
}

async function getActiveTemplateOrThrow(db: Queryable, workspaceId: string, id: string, channel: "email" | "whatsapp"): Promise<TemplateRow> {
  const result = await db.query<TemplateRow>(`select * from public.message_templates where id = $1 and workspace_id = $2`, [id, workspaceId]);
  const template = result.rows[0];
  if (!template) throw new NotFoundError("Template");
  if (template.channel !== channel) throw new ValidationError(`Template "${template.name}" is not a ${channel} template.`);
  if (!template.is_active) throw new ValidationError(`Template "${template.name}" is inactive.`);
  return template;
}

function toRenderLead(lead: LeadRow & { owner_name?: string | null }): TemplateRenderLead {
  return {
    firstName: lead.first_name,
    lastName: lead.last_name,
    company: lead.company,
    industry: lead.industry,
    email: lead.email,
    phone: lead.phone,
    ownerName: lead.owner_name ?? null,
  };
}

export interface CreateAndSendProposalInput {
  leadId: string;
  title: string;
  amount?: number;
  notes?: string;
  emailTemplateId: string;
  whatsappTemplateId: string;
  dealId?: string;
}

export interface ProposalDocumentFile {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
}

export async function createAndSendProposal(actor: Actor, workspaceId: string, input: CreateAndSendProposalInput, file: ProposalDocumentFile) {
  if (!input.title.trim()) throw new ValidationError("Proposal title is required.");
  if (!input.emailTemplateId || !input.whatsappTemplateId) {
    throw new ValidationError("An email template and a WhatsApp template are both required.");
  }

  const lead = await getLeadRowOr404(pool, workspaceId, input.leadId);
  if (lead.lifecycle_state === "do_not_contact") throw new DoNotContactError();

  // Both validated up front so a bad selection fails fast; the WhatsApp
  // template is re-read fresh in processQueuedProposalWhatsappSend.
  const [emailTemplate] = await Promise.all([
    getActiveTemplateOrThrow(pool, workspaceId, input.emailTemplateId, "email"),
    getActiveTemplateOrThrow(pool, workspaceId, input.whatsappTemplateId, "whatsapp"),
  ]);

  const emailEligible = Boolean(lead.email);
  const whatsappEligible = Boolean(lead.phone_e164);
  if (!emailEligible && !whatsappEligible) {
    throw new ValidationError("This lead has no email address or WhatsApp-capable phone number - nothing to send.");
  }

  const storagePath = `${input.leadId}/${randomUUID()}-${sanitizeFileName(file.originalName)}`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from(PROPOSAL_DOCUMENTS_BUCKET)
    .upload(storagePath, file.buffer, { contentType: file.mimeType, upsert: false });
  if (uploadError) throw new Error(`Failed to upload proposal document: ${uploadError.message}`);

  const created = await withTransaction(async (client) => {
    const proposal = await createProposal(client, actor, workspaceId, {
      leadId: input.leadId,
      title: input.title,
      amount: input.amount,
      notes: input.notes,
      documentStoragePath: storagePath,
      documentFileName: file.originalName,
      documentMimeType: file.mimeType,
      documentSizeBytes: file.size,
      emailTemplateId: input.emailTemplateId,
      whatsappTemplateId: input.whatsappTemplateId,
      emailSendStatus: emailEligible ? "pending" : "skipped",
      whatsappSendStatus: whatsappEligible ? "queued" : "skipped",
      dealId: input.dealId,
    });
    if (emailEligible) {
      const rendered = renderTemplate(emailTemplate, toRenderLead(lead));
      await enqueueEmail(client, {
        workspaceId,
        source: "proposal",
        sourceId: proposal.id,
        leadId: lead.id,
        to: lead.email!,
        subject: rendered.subject?.trim() || emailTemplate.name,
        html: rendered.body,
        attachments: [{ bucket: PROPOSAL_DOCUMENTS_BUCKET, path: storagePath, fileName: file.originalName, mimeType: file.mimeType, size: file.size }],
        createdBy: actor.id,
      });
    }
    return proposal;
  });
  // Both channels are left queued ("pending" email, "queued" WhatsApp) — the worker sends them.

  return getProposalOr404(pool, workspaceId, created.id);
}

/**
 * SKIP LOCKED claim, mirroring automation.service.ts's claimDueActions:
 * atomic so two worker poll ticks racing on the same rows never both claim
 * the same one. Claiming pushes whatsapp_next_attempt_at 15 minutes out, so a
 * row left 'sending' by a crashed worker is reclaimed after that (audit B19).
 */
export async function claimQueuedProposalWhatsappSends(db: Queryable, limit: number): Promise<ProposalRow[]> {
  const claimed = await db.query<ProposalRow>(
    `update public.proposals
        set whatsapp_send_status = 'sending', whatsapp_next_attempt_at = now() + interval '15 minutes'
      where id in (
        select id from public.proposals
         where whatsapp_send_status in ('queued', 'sending')
           and (whatsapp_next_attempt_at is null or whatsapp_next_attempt_at <= now())
         order by created_at asc
         limit $1
         for update skip locked
      )
      returning *`,
    [limit],
  );
  return claimed.rows;
}

export async function processQueuedProposalWhatsappSend(row: ProposalRow): Promise<void> {
  try {
    if (await wasSentForSource(pool, { type: "proposal", id: row.id })) {
      await pool.query(
        `update public.proposals set whatsapp_send_status = 'sent', whatsapp_sent_at = coalesce(whatsapp_sent_at, now()), whatsapp_send_error = null where id = $1`,
        [row.id],
      );
      await tryAdvanceToSent(row.workspace_id, row.id);
      return;
    }
    const lead = (await getLeadRowOr404(pool, row.workspace_id, row.lead_id)) as LeadRow & { owner_name: string | null };
    if (lead.lifecycle_state === "do_not_contact" || !lead.phone_e164) {
      await pool.query(`update public.proposals set whatsapp_send_status = 'failed', whatsapp_send_error = $2 where id = $1`, [
        row.id,
        lead.lifecycle_state === "do_not_contact" ? "Lead is now Do Not Contact." : "Lead no longer has a WhatsApp-capable phone number.",
      ]);
      return;
    }
    if (!row.whatsapp_template_id || !row.document_storage_path) {
      throw new Error("Queued WhatsApp proposal send is missing its template or document (invariant violation).");
    }
    const template = await getActiveTemplateOrThrow(pool, row.workspace_id, row.whatsapp_template_id, "whatsapp");
    const rendered = renderTemplate(template, toRenderLead(lead));
    const whatsappText = htmlToWhatsAppText(rendered.body);

    await sendWhatsApp(row.workspace_id, {
      source: { type: "proposal", id: row.id },
      to: lead.phone_e164,
      body: whatsappText,
      attachment: {
        storagePath: row.document_storage_path,
        fileName: row.document_file_name ?? "proposal",
        mimeType: row.document_mime_type ?? "application/octet-stream",
        bucket: PROPOSAL_DOCUMENTS_BUCKET,
      },
    });

    await pool.query(
      `update public.proposals set whatsapp_send_status = 'sent', whatsapp_sent_at = now(), whatsapp_send_error = null where id = $1`,
      [row.id],
    );
    await tryAdvanceToSent(row.workspace_id, row.id);
  } catch (err) {
    // A deferral (disconnected, manager starting, daily cap, restriction) is not
    // an attempt; give up only once the proposal has waited too long.
    if (err instanceof ProviderDeferredError) {
      // The WhatsApp send is queued when the proposal is created.
      if (Date.now() - row.created_at.getTime() >= PROPOSAL_WHATSAPP_MAX_DEFERRAL_MS) {
        await pool.query(`update public.proposals set whatsapp_send_status = 'failed', whatsapp_send_error = $2 where id = $1`, [
          row.id,
          `Gave up: WhatsApp stayed unavailable for ${PROPOSAL_WHATSAPP_MAX_DEFERRAL_MS / 3_600_000} hours. Last reason: ${err.message}`,
        ]);
        return;
      }
      await pool.query(
        `update public.proposals
            set whatsapp_send_status = 'queued',
                whatsapp_next_attempt_at = now() + ($2 || ' milliseconds')::interval, whatsapp_send_error = $3
          where id = $1`,
        [row.id, String(err.retryAfterMs), err.message],
      );
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(`update public.proposals set whatsapp_send_status = 'failed', whatsapp_send_error = $2 where id = $1`, [row.id, message]);
  }
}

/**
 * GET /proposals/:id/document (C6b): a short-lived (5 min) signed URL for the proposal's
 * file in the private bucket. The proposal row is read with the workspace check, so a
 * storage path of another workspace is never touched; no file (or a missing object) → 404.
 */
export async function getProposalDocumentLink(db: Queryable, workspaceId: string, id: string) {
  const row = await getProposalRowOr404(db, workspaceId, id);
  if (!row.document_storage_path) throw new NotFoundError("Proposal document");
  const { data, error } = await supabaseAdmin.storage.from(PROPOSAL_DOCUMENTS_BUCKET).createSignedUrl(row.document_storage_path, DOCUMENT_LINK_TTL_SECONDS);
  if (error || !data?.signedUrl) throw new NotFoundError("Proposal document");
  return {
    url: data.signedUrl,
    fileName: row.document_file_name ?? row.document_reference ?? null,
    expiresAt: new Date(Date.now() + DOCUMENT_LINK_TTL_SECONDS * 1000).toISOString(),
  };
}
