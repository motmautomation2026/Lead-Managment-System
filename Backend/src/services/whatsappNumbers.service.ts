import type { Actor } from "../authMiddleware.js";
import { withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { moveProblem, pickNumber, type NumberCandidate } from "../domain/whatsappNumbers.js";
import { warmupDayFor } from "../domain/whatsappSafety.js";
import { PermanentProviderError, ProviderDeferredError } from "../providers/provider-errors.js";
import { recordAdminAudit } from "./admin-audit.service.js";
import { actorEvent, addTimelineEvent } from "./timeline.service.js";
import { IST_MIDNIGHT } from "./whatsappSafety.service.js";

/**
 * E4a: the DB side of domain/whatsappNumbers.ts — candidates for the number choice, the sticky
 * assignment before a send, the admin move (rule 6), adding and removing numbers (rule 10).
 */

interface CandidateRow {
  id: string;
  label: string;
  owner_user_id: string | null;
  status: string;
  enabled: boolean;
  removed_at: Date | null;
  daily_cap: number;
  paired_at: Date | null;
  sent_today: number;
  new_chats_today: number;
}

/** The workspace's numbers (not removed, plus `alsoId` even if removed) with today's per-number counts (indexed by number). */
export async function loadNumberCandidates(db: Queryable, workspaceId: string, alsoId: string | null = null, now = new Date()): Promise<NumberCandidate[]> {
  const rows = await db.query<CandidateRow>(
    `select n.id, n.label, n.owner_user_id, n.status, n.enabled and c.outbound_enabled as enabled, n.removed_at, n.daily_cap, n.paired_at,
            (select count(*)::int from public.whatsapp_outbound_messages o
              where o.whatsapp_number_id = n.id and o.status = 'sent' and o.sent_at >= ${IST_MIDNIGHT}) as sent_today,
            (select count(*)::int from public.whatsapp_outbound_messages o
              where o.whatsapp_number_id = n.id and o.status = 'sent' and o.new_chat and o.sent_at >= ${IST_MIDNIGHT}) as new_chats_today
       from public.whatsapp_numbers n
       join public.whatsapp_connection c on c.workspace_id = n.workspace_id
      where n.workspace_id = $1 and (n.removed_at is null or n.id = $2)
      order by n.created_at, n.id`,
    [workspaceId, alsoId],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    label: r.label,
    ownerUserId: r.owner_user_id,
    connected: r.status === "connected",
    paused: !r.enabled,
    removed: r.removed_at !== null,
    dailyCap: r.daily_cap,
    warmupDay: warmupDayFor(r.paired_at, now),
    sentToday: r.sent_today,
    newChatsToday: r.new_chats_today,
    pairedAt: r.paired_at,
  }));
}

/**
 * Rules 3–5, before every WhatsApp send (any source): the lead's sticky number, or one chosen by
 * rule 4 and stored under the lead row lock (two concurrent sends can't assign two numbers; the
 * second sees the first's choice). No usable number → ProviderDeferredError (no attempt burned).
 */
export async function resolveSendNumber(workspaceId: string, leadId: string | null): Promise<string> {
  if (!leadId) throw new PermanentProviderError("This WhatsApp action has no contact.");
  return withTransaction(async (db) => {
    const lead = await db.query<{ whatsapp_number_id: string | null; owner_id: string | null }>(
      `select whatsapp_number_id, owner_id from public.leads where id = $1 and workspace_id = $2 for update`,
      [leadId, workspaceId],
    );
    const row = lead.rows[0];
    if (!row) throw new PermanentProviderError("The contact for this WhatsApp action no longer exists.");
    const pick = pickNumber(row.whatsapp_number_id, await loadNumberCandidates(db, workspaceId, row.whatsapp_number_id), row.owner_id);
    if ("wait" in pick) throw new ProviderDeferredError(pick.wait, pick.retryAfterMs);
    if (pick.assign) await db.query(`update public.leads set whatsapp_number_id = $2 where id = $1 and whatsapp_number_id is null`, [leadId, pick.numberId]);
    return pick.numberId;
  });
}

/** Prepared (claimed, not yet sent) outbound rows of one lead — "queued" WhatsApp sends that follow a move. */
const LEAD_PREPARED_ROWS = `
  select o.id from public.whatsapp_outbound_messages o
    left join public.scheduled_actions sa on sa.id = o.scheduled_action_id
    left join public.proposals p on p.id = o.proposal_id
    left join public.meetings m on m.id = o.meeting_id
    left join public.agent_decisions ad on ad.id = o.agent_decision_id
    left join public.reply_drafts rd on rd.id = o.reply_draft_id
   where o.workspace_id = $1 and o.status = 'prepared' and coalesce(sa.lead_id, p.lead_id, m.lead_id, ad.lead_id, rd.lead_id) = $2`;

async function moveLead(db: Queryable, actor: Actor, workspaceId: string, leadId: string, from: string | null, to: { id: string; label: string }, reason: string) {
  await db.query(`update public.leads set whatsapp_number_id = $2 where id = $1`, [leadId, to.id]);
  await db.query(`update public.whatsapp_outbound_messages set whatsapp_number_id = $3 where id in (${LEAD_PREPARED_ROWS})`, [workspaceId, leadId, to.id]);
  await addTimelineEvent(db, {
    leadId,
    kind: "whatsapp",
    title: `WhatsApp number changed to ${to.label}`,
    detail: reason,
    metadata: { fromNumberId: from, toNumberId: to.id },
    ...actorEvent(actor),
  });
  await recordAdminAudit(db, actor, "lead.whatsapp_number_changed", "lead", leadId, { from, to: to.id, reason });
}

/** Rule 6 — admin only (route guard): moves a contact to another number with a reason; audited; timeline event; queued rows follow. */
export async function changeLeadNumber(actor: Actor, workspaceId: string, leadId: string, input: { numberId: string; reason: string }) {
  return withTransaction(async (db) => {
    const lead = await db.query<{ whatsapp_number_id: string | null }>(
      `select whatsapp_number_id from public.leads where id = $1 and workspace_id = $2 for update`,
      [leadId, workspaceId],
    );
    if (!lead.rows[0]) throw new NotFoundError("Contact");
    const current = lead.rows[0].whatsapp_number_id;
    const target = (await loadNumberCandidates(db, workspaceId)).find((n) => n.id === input.numberId);
    const problem = moveProblem(current, target, input.reason);
    if (problem) throw new ValidationError(problem);
    await moveLead(db, actor, workspaceId, leadId, current, target!, input.reason.trim());
    return { whatsappNumber: { id: target!.id, label: target!.label } };
  });
}

/** Admin only: a new number that starts pairing (QR) on the next worker tick; at most `max_numbers` per workspace. */
export async function addNumber(actor: Actor, workspaceId: string, input: { label?: string; ownerUserId?: string | null }) {
  return withTransaction(async (db) => {
    const ws = await db.query<{ max_numbers: number }>(`select max_numbers from public.whatsapp_connection where workspace_id = $1 for update`, [workspaceId]);
    const max = ws.rows[0]?.max_numbers ?? 0;
    const counts = await db.query<{ active: number; all: number }>(
      `select count(*) filter (where removed_at is null)::int as active, count(*)::int as all from public.whatsapp_numbers where workspace_id = $1`,
      [workspaceId],
    );
    const { active, all } = counts.rows[0]!;
    if (active >= max) throw new ConflictError(`This workspace already has ${active} WhatsApp numbers (the maximum is ${max}).`);
    const created = await db.query<{ id: string }>(
      `insert into public.whatsapp_numbers (workspace_id, label, owner_user_id, desired_state, command_version, updated_by)
       values ($1, $2, $3, 'connected', 1, $4) returning id`,
      [workspaceId, input.label?.trim() || `#${all + 1}`, input.ownerUserId ?? null, actor.id],
    );
    const id = created.rows[0]!.id;
    await recordAdminAudit(db, actor, "connection.whatsapp.number_added", "whatsapp_number", id, { ...input });
    return id;
  });
}

/**
 * Rule 10 — admin only: soft delete (`removed_at`; history keeps the id), logout on the next
 * worker tick, auth state deleted now. With queued (prepared) sends the admin must choose: move
 * its contacts to another number (rule 6, a timeline event each) or leave them without one (they
 * get a number by rule 4 at their next send). Without queued sends its contacts are unassigned.
 */
export async function removeNumber(actor: Actor, workspaceId: string, numberId: string, input: { leads?: "move" | "unassign"; moveToNumberId?: string }) {
  await withTransaction(async (db) => {
    const number = await db.query<{ label: string }>(
      `select label from public.whatsapp_numbers where id = $1 and workspace_id = $2 and removed_at is null for update`,
      [numberId, workspaceId],
    );
    if (!number.rows[0]) throw new NotFoundError("WhatsApp number");
    const others = (await loadNumberCandidates(db, workspaceId)).filter((n) => n.id !== numberId);
    if (!others.length) throw new ConflictError("A workspace keeps at least one WhatsApp number. Log this one out instead.");
    const queued = await db.query<{ count: number }>(
      `select count(*)::int as count from public.whatsapp_outbound_messages where whatsapp_number_id = $1 and status = 'prepared'`,
      [numberId],
    );
    const queuedCount = queued.rows[0]!.count;
    if (queuedCount > 0 && !input.leads) {
      throw new ConflictError(
        `This number has ${queuedCount} queued WhatsApp send(s). Choose to move its contacts to another number or leave them without a number.`,
        { queuedSends: queuedCount },
      );
    }
    const reason = `WhatsApp number ${number.rows[0].label} was removed.`;
    if (input.leads === "move") {
      const target = others.find((n) => n.id === input.moveToNumberId);
      if (!target) throw new ValidationError("Choose another WhatsApp number of this workspace to move the contacts to.");
      const leads = await db.query<{ id: string }>(`select id from public.leads where whatsapp_number_id = $1 for update`, [numberId]);
      for (const lead of leads.rows) await moveLead(db, actor, workspaceId, lead.id, numberId, target, reason);
    } else {
      await db.query(`update public.leads set whatsapp_number_id = null where whatsapp_number_id = $1`, [numberId]);
      await db.query(`update public.whatsapp_outbound_messages set whatsapp_number_id = null where whatsapp_number_id = $1 and status = 'prepared'`, [numberId]);
    }
    await db.query(
      `update public.whatsapp_numbers
          set removed_at = now(), removed_by = $2, enabled = false, desired_state = 'disconnected', command_version = command_version + 1,
              qr_ciphertext = null, qr_iv = null, qr_tag = null, qr_expires_at = null, updated_by = $2, updated_at = now()
        where id = $1`,
      [numberId, actor.id],
    );
    await db.query(`delete from public.whatsapp_number_auth_keys where number_id = $1`, [numberId]);
    await db.query(`delete from public.whatsapp_number_auth_credentials where number_id = $1`, [numberId]);
    await recordAdminAudit(db, actor, "connection.whatsapp.number_removed", "whatsapp_number", numberId, { ...input, queuedSends: queuedCount });
  });
}

/** The contact record's "WhatsApp number: <label>". */
export async function leadNumber(db: Queryable, leadId: string): Promise<{ id: string; label: string } | null> {
  const result = await db.query<{ id: string; label: string }>(
    `select n.id, n.label from public.leads l join public.whatsapp_numbers n on n.id = l.whatsapp_number_id where l.id = $1`,
    [leadId],
  );
  return result.rows[0] ?? null;
}

