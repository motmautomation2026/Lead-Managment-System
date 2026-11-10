import type { Queryable } from "../dto.js";
import { pool } from "../db.js";
import { NotFoundError } from "../errors.js";
import { getLeadRowOr404, type LeadRow } from "./leads.service.js";
import { toRenderMeeting, type MeetingRow } from "./meetings.service.js";
import { renderTemplate, type TemplateRenderLead } from "../domain/templateRenderer.js";
import { htmlToWhatsAppText } from "../domain/htmlToWhatsAppText.js";
import { enqueueEmail } from "./emailOutbound.service.js";
import { sendWhatsApp, wasSentForSource } from "../providers/whatsapp.provider.js";
import { ProviderDeferredError } from "../providers/provider-errors.js";
import { fairPickSql } from "./fairPick.js";

/**
 * Sends the "meeting scheduled" confirmation to the lead on both channels,
 * using ONE fixed default template per channel (set once by an admin in
 * Templates — see the is_default_meeting_scheduled_* columns). Same division
 * of labor as proposalSending.service.ts's createAndSendProposal: only the
 * worker sends — the email through the outbound email queue (E1b), the
 * WhatsApp side left "queued" for the worker's poll loop to drain. Called as a
 * best-effort step after the meeting is already scheduled and synced to
 * Calendar — never blocks or fails meeting creation.
 */

interface NotificationTemplateRow {
  id: string;
  name: string;
  channel: "email" | "whatsapp";
  subject: string | null;
  body: string;
  is_active: boolean;
}

/**
 * Reads the meeting row directly (rather than meetings.service's
 * getMeetingRowOr404, which now requires a workspaceId) since this module's
 * entry points only ever receive a meetingId that a caller already resolved
 * within the correct workspace — the meeting's own workspace_id column is
 * then the source of truth for every downstream call in this file.
 */
async function getMeetingRowById(meetingId: string): Promise<MeetingRow> {
  const result = await pool.query<MeetingRow>(`select * from public.meetings where id = $1`, [meetingId]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Meeting");
  return row;
}

/** The workspace's active default "Meeting Scheduled" template for a channel (at most one, per 019's indexes). */
export async function getDefaultTemplate(
  workspaceId: string,
  channel: "email" | "whatsapp",
  db: Queryable = pool,
): Promise<NotificationTemplateRow | null> {
  const column = channel === "email" ? "is_default_meeting_scheduled_email" : "is_default_meeting_scheduled_whatsapp";
  const result = await db.query<NotificationTemplateRow>(
    `select * from public.message_templates where workspace_id = $1 and ${column} = true and is_active = true limit 1`,
    [workspaceId],
  );
  return result.rows[0] ?? null;
}

function toRenderLead(lead: LeadRow): TemplateRenderLead {
  return {
    firstName: lead.first_name,
    lastName: lead.last_name,
    company: lead.company,
    industry: lead.industry,
    email: lead.email,
    phone: lead.phone,
    ownerName: lead.owner_name,
  };
}

/** Renders the default email template and queues it (status "pending" = queued); the worker sends it. */
async function queueMeetingEmail(meeting: MeetingRow, lead: LeadRow): Promise<void> {
  try {
    const template = await getDefaultTemplate(meeting.workspace_id, "email");
    if (!template) {
      await pool.query(
        `update public.meetings set notify_email_status = 'skipped', notify_email_error = $2 where id = $1`,
        [meeting.id, "No default \"Meeting Scheduled\" email template is configured (Automations → Templates)."],
      );
      return;
    }
    const rendered = renderTemplate(template, toRenderLead(lead), toRenderMeeting(meeting));
    // Pending first: the worker may send (→ sent) as soon as the row is queued.
    await pool.query(`update public.meetings set notify_email_status = 'pending', notify_email_error = null where id = $1`, [meeting.id]);
    await enqueueEmail(pool, {
      workspaceId: meeting.workspace_id,
      source: "meeting",
      sourceId: meeting.id,
      leadId: lead.id,
      to: lead.email!,
      subject: rendered.subject?.trim() || template.name,
      html: rendered.body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(`update public.meetings set notify_email_status = 'failed', notify_email_error = $2 where id = $1`, [meeting.id, message]);
  }
}

/** Best-effort — never throws, so a failure here can't undo the meeting/Calendar sync that already succeeded. */
export async function notifyMeetingScheduled(meetingId: string): Promise<void> {
  const meeting = await getMeetingRowById(meetingId);
  const lead = await getLeadRowOr404(pool, meeting.workspace_id, meeting.lead_id);

  if (lead.email) {
    await queueMeetingEmail(meeting, lead);
  } else {
    await pool.query(`update public.meetings set notify_email_status = 'skipped' where id = $1`, [meetingId]);
  }

  await pool.query(`update public.meetings set notify_whatsapp_status = $2 where id = $1`, [
    meetingId,
    lead.phone_e164 ? "queued" : "skipped",
  ]);
}

/** SKIP LOCKED claim with a 15-minute reclaim of stuck 'sending' rows, mirroring claimQueuedProposalWhatsappSends. */
export async function claimQueuedMeetingWhatsappSends(db: Queryable, limit: number): Promise<MeetingRow[]> {
  const claimed = await db.query<MeetingRow>(
    `update public.meetings
        set notify_whatsapp_status = 'sending', notify_whatsapp_next_attempt_at = now() + interval '15 minutes'
      where id in (
        select id from public.meetings
         where id in (${fairPickSql({
           from: "public.meetings x",
           where: "x.notify_whatsapp_status in ('queued', 'sending') and (x.notify_whatsapp_next_attempt_at is null or x.notify_whatsapp_next_attempt_at <= now())",
           order: "x.created_at",
           limit: "$1",
         })})
           -- P7: round-robin across workspaces; repeated so the lock re-checks the latest row.
           and notify_whatsapp_status in ('queued', 'sending')
           and (notify_whatsapp_next_attempt_at is null or notify_whatsapp_next_attempt_at <= now())
         for update skip locked
      )
      returning *`,
    [limit],
  );
  return claimed.rows;
}

export async function processQueuedMeetingWhatsappSend(row: MeetingRow): Promise<void> {
  try {
    if (await wasSentForSource(pool, { type: "meeting", id: row.id })) {
      await pool.query(
        `update public.meetings set notify_whatsapp_status = 'sent', notify_whatsapp_sent_at = coalesce(notify_whatsapp_sent_at, now()), notify_whatsapp_error = null where id = $1`,
        [row.id],
      );
      return;
    }
    const lead = await getLeadRowOr404(pool, row.workspace_id, row.lead_id);
    if (lead.lifecycle_state === "do_not_contact" || !lead.phone_e164) {
      await pool.query(`update public.meetings set notify_whatsapp_status = 'failed', notify_whatsapp_error = $2 where id = $1`, [
        row.id,
        lead.lifecycle_state === "do_not_contact" ? "Lead is now Do Not Contact." : "Lead no longer has a WhatsApp-capable phone number.",
      ]);
      return;
    }
    const template = await getDefaultTemplate(row.workspace_id, "whatsapp");
    if (!template) {
      await pool.query(
        `update public.meetings set notify_whatsapp_status = 'failed', notify_whatsapp_error = $2 where id = $1`,
        [row.id, "No default \"Meeting Scheduled\" WhatsApp template is configured (Automations → Templates)."],
      );
      return;
    }
    const rendered = renderTemplate(template, toRenderLead(lead), toRenderMeeting(row));
    const whatsappText = htmlToWhatsAppText(rendered.body);

    await sendWhatsApp(row.workspace_id, { source: { type: "meeting", id: row.id }, to: lead.phone_e164, body: whatsappText });

    await pool.query(
      `update public.meetings set notify_whatsapp_status = 'sent', notify_whatsapp_sent_at = now(), notify_whatsapp_error = null where id = $1`,
      [row.id],
    );
  } catch (err) {
    // A deferral (disconnected, manager starting, daily cap, restriction) is not
    // an attempt; the notification is only pointless once the meeting has started.
    if (err instanceof ProviderDeferredError) {
      if (row.scheduled_at.getTime() <= Date.now()) {
        await pool.query(`update public.meetings set notify_whatsapp_status = 'skipped', notify_whatsapp_error = $2 where id = $1`, [
          row.id,
          `Not sent: the meeting time passed while WhatsApp was unavailable. Last reason: ${err.message}`,
        ]);
        return;
      }
      await pool.query(
        `update public.meetings
            set notify_whatsapp_status = 'queued',
                notify_whatsapp_next_attempt_at = now() + ($2 || ' milliseconds')::interval, notify_whatsapp_error = $3
          where id = $1`,
        [row.id, String(err.retryAfterMs), err.message],
      );
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(`update public.meetings set notify_whatsapp_status = 'failed', notify_whatsapp_error = $2 where id = $1`, [row.id, message]);
  }
}
