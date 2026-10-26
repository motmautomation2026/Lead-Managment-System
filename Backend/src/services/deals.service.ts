import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { pool } from "../db.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { DealStage, LeadLossReason, LifecycleState, MeetingOutcome, MeetingStatus, ProposalStatus } from "../domain/enums.js";
import { isPlaceholderCompany } from "../domain/companyNormalize.js";
import {
  DEAL_STAGE_LABELS,
  backfillDealStage,
  canMoveDealStage,
  DEAL_CLOSED_LOSS_REASON,
  defaultDealName,
  isClosedDealStage,
  pickDealToAttach,
} from "../domain/dealRouting.js";
import { addTimelineEvent, actorEvent, AUTOMATION_ACTOR } from "./timeline.service.js";
import { getLeadRowOr404, markWon, type LeadRow } from "./leads.service.js";

export type DealSource = "meeting" | "proposal" | "manual" | "backfill";

export interface DealRow {
  id: string;
  workspace_id: string;
  name: string;
  lead_id: string;
  company_id: string | null;
  owner_id: string | null;
  stage: DealStage;
  amount: string | null;
  currency: string;
  expected_close_date: string | null;
  service_interest: string | null;
  source: DealSource;
  loss_reason: LeadLossReason | null;
  loss_notes: string | null;
  closed_at: Date | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const eventActor = (actor: Actor | null) => (actor ? actorEvent(actor) : AUTOMATION_ACTOR);

export interface CreateDealInput {
  leadId: string;
  source: DealSource;
  name?: string;
  stage?: DealStage;
  amount?: number | string | null;
  currency?: string | null;
  expectedCloseDate?: string | null;
  lossReason?: LeadLossReason | null;
  lossNotes?: string | null;
  /** Manual create only (already validated): a user id or null; omitted = the contact's owner. */
  ownerId?: string | null;
  /** Backfill only: when a closed deal closed. Defaults to now. */
  closedAt?: Date | null;
}

/** Company, owner (unless `ownerId` is given) and service interest come from the contact (design §1.3). */
export async function createDeal(db: Queryable, actor: Actor | null, workspaceId: string, input: CreateDealInput, lead?: LeadRow): Promise<DealRow> {
  const contact = lead ?? (await getLeadRowOr404(db, workspaceId, input.leadId));
  const stage = input.stage ?? "qualified";
  if (stage === "lost" && !input.lossReason) throw new ValidationError("A loss reason is required for a lost deal.");
  const companyName = isPlaceholderCompany(contact.company) ? `${contact.first_name} ${contact.last_name}` : contact.company;
  const name = input.name?.trim() || defaultDealName(companyName, contact.service_interest);
  const closed = isClosedDealStage(stage);

  const { rows } = await db.query<DealRow>(
    `insert into public.deals
      (workspace_id, name, lead_id, company_id, owner_id, stage, amount, currency, expected_close_date,
       service_interest, source, loss_reason, loss_notes, closed_at, created_by, created_by_name)
     values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'INR'),$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
    [
      workspaceId,
      name,
      contact.id,
      contact.company_id,
      input.ownerId === undefined ? contact.owner_id : input.ownerId,
      stage,
      input.amount ?? null,
      input.currency ?? null,
      input.expectedCloseDate ?? null,
      contact.service_interest,
      input.source,
      stage === "lost" ? input.lossReason : null,
      stage === "lost" ? input.lossNotes?.trim() || null : null,
      closed ? (input.closedAt ?? new Date()) : null,
      actor?.id ?? null,
      actor?.fullName ?? AUTOMATION_ACTOR.actorName,
    ],
  );
  const deal = rows[0]!;
  await addTimelineEvent(db, { leadId: contact.id, kind: "system", title: "Deal created", detail: `${name} (${DEAL_STAGE_LABELS[stage]})`, ...eventActor(actor), relatedDealId: deal.id });
  return deal;
}

async function lockDealOr404(db: Queryable, workspaceId: string, dealId: string): Promise<DealRow> {
  const { rows } = await db.query<DealRow>(`select * from public.deals where id = $1 and workspace_id = $2 for update`, [dealId, workspaceId]);
  if (!rows[0]) throw new NotFoundError("Deal");
  return rows[0];
}

export interface MoveDealStageOptions {
  manual: boolean;
  /** The meeting outcome / proposal status behind an event-driven move (enables its backward exception). */
  event?: MeetingOutcome | ProposalStatus;
  lossReason?: LeadLossReason;
  lossNotes?: string;
  amount?: number | string | null;
}

/**
 * Moves a deal (rules in canMoveDealStage). A move that isn't allowed is a no-op
 * (`moved: false`). Event-driven moves never touch the contact (today's routing
 * already does). Only a manual move to won with no other open deal wins the
 * contact, through the existing markWon (so its triggers fire as today).
 */
export async function moveDealStage(
  db: Queryable,
  actor: Actor | null,
  workspaceId: string,
  dealId: string,
  toStage: DealStage,
  options: MoveDealStageOptions,
): Promise<{ deal: DealRow; moved: boolean }> {
  const current = await lockDealOr404(db, workspaceId, dealId);
  if (!canMoveDealStage(current.stage, toStage, options)) return { deal: current, moved: false };
  if (toStage === "lost" && !options.lossReason) throw new ValidationError("A loss reason is required to mark a deal lost.");

  const lost = toStage === "lost";
  const { rows } = await db.query<DealRow>(
    `update public.deals
        set stage = $2,
            closed_at = case when $3 then now() else null end,
            loss_reason = $4, loss_notes = $5,
            amount = coalesce($6, amount)
      where id = $1 returning *`,
    [dealId, toStage, isClosedDealStage(toStage), lost ? options.lossReason : null, lost ? options.lossNotes?.trim() || null : null, options.amount ?? null],
  );
  const deal = rows[0]!;
  await addTimelineEvent(db, {
    leadId: deal.lead_id,
    kind: "system",
    title: `Deal stage changed: ${DEAL_STAGE_LABELS[current.stage]} → ${DEAL_STAGE_LABELS[toStage]}`,
    detail: deal.name,
    ...eventActor(actor),
    relatedDealId: deal.id,
    metadata: { from: current.stage, to: toStage, manual: options.manual },
  });

  if (options.manual && toStage === "won" && (await openDealIds(db, deal.lead_id)).length === 0) {
    const contact = await getLeadRowOr404(db, workspaceId, deal.lead_id);
    // A deal never lifts DNC or revives a merged contact.
    if (contact.lifecycle_state !== "do_not_contact" && contact.lifecycle_state !== "merged") {
      await markWon(db, actor, workspaceId, deal.lead_id, `Deal won: ${deal.name}`);
    }
  }
  return { deal, moved: true };
}

async function openDeals(db: Queryable, leadId: string) {
  const { rows } = await db.query<{ id: string; updated_at: Date }>(
    `select id, updated_at from public.deals where lead_id = $1 and stage not in ('won', 'lost') order by updated_at desc, id for update`,
    [leadId],
  );
  return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at }));
}

const openDealIds = async (db: Queryable, leadId: string) => (await openDeals(db, leadId)).map((d) => d.id);

/**
 * Runs deal work inside a SAVEPOINT so it never blocks the meeting/proposal/
 * contact change it hangs off: on failure it's rolled back and logged (codes
 * only), and the sweeper later attaches anything left unlinked. A bad requested
 * dealId (ValidationError) is the caller's mistake and is rethrown.
 */
async function dealSafely(db: Queryable, what: string, leadId: string, work: () => Promise<void>): Promise<void> {
  try {
    await db.query("savepoint deal_hook");
  } catch (error) {
    console.warn(`[deals] ${what} for lead ${leadId} skipped: ${errorCode(error)}`);
    return;
  }
  try {
    await work();
    await db.query("release savepoint deal_hook");
  } catch (error) {
    await db.query("rollback to savepoint deal_hook").catch(() => undefined);
    await db.query("release savepoint deal_hook").catch(() => undefined);
    if (error instanceof ValidationError) throw error;
    console.warn(`[deals] ${what} for lead ${leadId} failed: ${errorCode(error)}`);
  }
}

// Codes / class names only: a pg message can quote row values.
function errorCode(error: unknown): string {
  const e = error as { code?: string; name?: string };
  return e?.code ?? e?.name ?? "unknown error";
}

export interface AttachDealInput {
  leadId: string;
  requestedDealId?: string;
  meetingId?: string;
  proposalId?: string;
  amount?: number | string | null;
  currency?: string | null;
}

/**
 * Meeting booked / proposal created (design §2.2): attach to the requested or the
 * newest open deal (moving it forward to the event's stage, never backwards), else
 * create one at that stage. A proposal's amount fills an empty deal amount.
 */
export async function attachDealSafely(db: Queryable, actor: Actor | null, workspaceId: string, input: AttachDealInput): Promise<void> {
  const stage: DealStage = input.proposalId ? "proposal_preparation" : "meeting_scheduled";
  await dealSafely(db, input.proposalId ? "proposal deal" : "meeting deal", input.leadId, async () => {
    const choice = pickDealToAttach(await openDeals(db, input.leadId), input.requestedDealId);
    let dealId: string;
    if (choice.action === "create") {
      dealId = (await createDeal(db, actor, workspaceId, { leadId: input.leadId, source: input.proposalId ? "proposal" : "meeting", stage, amount: input.amount, currency: input.currency })).id;
    } else {
      dealId = choice.dealId;
      await moveDealStage(db, actor, workspaceId, dealId, stage, { manual: false });
      if (input.amount != null) {
        await db.query(`update public.deals set amount = $2, currency = coalesce($3, currency) where id = $1 and amount is null`, [dealId, input.amount, input.currency ?? null]);
      }
    }
    if (input.meetingId) await db.query(`update public.meetings set deal_id = $2 where id = $1`, [input.meetingId, dealId]);
    if (input.proposalId) await db.query(`update public.proposals set deal_id = $2 where id = $1`, [input.proposalId, dealId]);
  });
}

/** Meeting outcome / proposal status → the linked deal (event-driven, never touches the contact). */
export async function moveLinkedDealSafely(
  db: Queryable,
  actor: Actor | null,
  workspaceId: string,
  leadId: string,
  dealId: string | null,
  toStage: DealStage | null,
  options: Omit<MoveDealStageOptions, "manual">,
): Promise<void> {
  if (!dealId || !toStage) return;
  await dealSafely(db, "deal stage", leadId, async () => {
    await moveDealStage(db, actor, workspaceId, dealId, toStage, { ...options, manual: false });
  });
}

/** Contact lost / discarded / DNC / merged → its open deals are lost (design §2.2). */
export async function closeOpenDealsSafely(db: Queryable, actor: Actor | null, workspaceId: string, leadId: string, state: LifecycleState): Promise<void> {
  await dealSafely(db, "close deals", leadId, async () => {
    for (const id of await openDealIds(db, leadId)) {
      await moveDealStage(db, actor, workspaceId, id, "lost", { manual: false, lossReason: DEAL_CLOSED_LOSS_REASON, lossNotes: `Contact ${state.replace(/_/g, " ")}` });
    }
  });
}

/** Contact won via the old Won button → its deal is won only when there is exactly one open deal. */
export async function winSingleOpenDealSafely(db: Queryable, actor: Actor | null, workspaceId: string, leadId: string): Promise<void> {
  await dealSafely(db, "win deal", leadId, async () => {
    const ids = await openDealIds(db, leadId);
    if (ids.length === 1) await moveDealStage(db, actor, workspaceId, ids[0]!, "won", { manual: false });
  });
}

// --- Backfill sweeper (design §3) ------------------------------------------------

export interface DealSweepCounts {
  processed: number;
  created: number;
  attachedMeetings: number;
  attachedProposals: number;
  failed: number;
  workspacesCompleted: number;
}

/** Contacts whose backfill failed: skipped for the rest of this process's life. */
const failedContacts = new Set<string>();

async function backfillContact(db: Queryable, workspaceId: string, leadId: string): Promise<{ created: boolean; meetings: number; proposals: number }> {
  const lead = await getLeadRowOr404(db, workspaceId, leadId);
  const existing = await db.query<{ id: string; open: boolean }>(
    `select id, stage not in ('won', 'lost') as open from public.deals where lead_id = $1 order by updated_at desc, id`,
    [leadId],
  );
  // Newest open deal, else (only closed deals) the newest deal: never a duplicate won/lost deal.
  let dealId = (existing.rows.find((d) => d.open) ?? existing.rows[0])?.id;
  let created = false;
  if (!dealId) {
    const proposal = (
      await db.query<{ status: ProposalStatus; loss_reason: LeadLossReason | null; loss_notes: string | null; amount: string | null; currency: string }>(
        `select status, loss_reason, loss_notes, amount, currency from public.proposals where lead_id = $1 order by created_at desc, id limit 1`,
        [leadId],
      )
    ).rows[0];
    const meeting = (
      await db.query<{ status: MeetingStatus; outcome: MeetingOutcome | null }>(
        `select status, outcome from public.meetings where lead_id = $1 order by scheduled_at desc, id limit 1`,
        [leadId],
      )
    ).rows[0];
    const { stage, lossReason } = backfillDealStage({
      lifecycleState: lead.lifecycle_state,
      pipelineStage: lead.pipeline_stage,
      contactLossReason: lead.loss_reason,
      latestProposal: proposal ? { status: proposal.status, lossReason: proposal.loss_reason } : null,
      latestMeeting: meeting ?? null,
    });
    const contactClosed = lead.lifecycle_state !== "active" && lead.lifecycle_state !== "long_term_nurture" && lead.lifecycle_state !== "won";
    const deal = await createDeal(
      db,
      null,
      workspaceId,
      {
        leadId,
        source: "backfill",
        stage,
        amount: proposal?.amount ?? null,
        currency: proposal?.currency ?? null,
        lossReason,
        lossNotes: stage === "lost" ? (contactClosed ? `Contact ${lead.lifecycle_state.replace(/_/g, " ")}` : proposal?.loss_notes) : null,
        closedAt: isClosedDealStage(stage) ? lead.updated_at : null,
      },
      lead,
    );
    dealId = deal.id;
    created = true;
  }
  const meetings = await db.query(`update public.meetings set deal_id = $2 where lead_id = $1 and deal_id is null`, [leadId, dealId]);
  const proposals = await db.query(`update public.proposals set deal_id = $2 where lead_id = $1 and deal_id is null`, [leadId, dealId]);
  return { created, meetings: meetings.rowCount ?? 0, proposals: proposals.rowCount ?? 0 };
}

/**
 * The deal backfill sweeper: contacts with a meeting or proposal not linked to a
 * deal (old data, or an inline hook that failed), oldest first, up to `limit` per
 * call, ONE connection, one short transaction per contact, SKIP LOCKED. A contact
 * that fails is logged (ids/codes only) and skipped for the rest of the process.
 * `workspaceId` is for tests and scripts. Returns counts only.
 */
export async function runDealSweep(options: { limit?: number; workspaceId?: string } = {}): Promise<DealSweepCounts> {
  const limit = options.limit ?? 100;
  const counts: DealSweepCounts = { processed: 0, created: 0, attachedMeetings: 0, attachedProposals: 0, failed: 0, workspacesCompleted: 0 };
  const tried: string[] = [];
  const client = await pool.connect();
  try {
    while (counts.processed + counts.failed < limit) {
      await client.query("begin");
      let leadId: string | undefined;
      try {
        const next = (
          await client.query<{ id: string; workspace_id: string }>(
            `select l.id, l.workspace_id from public.leads l
              where l.id in (select lead_id from public.meetings where deal_id is null
                             union select lead_id from public.proposals where deal_id is null)
                and ($1::uuid is null or l.workspace_id = $1::uuid) and not (l.id = any($2::uuid[]))
              order by l.created_at, l.id
              limit 1
              for update of l skip locked`,
            [options.workspaceId ?? null, [...tried, ...failedContacts]],
          )
        ).rows[0];
        if (!next) {
          await client.query("commit");
          break;
        }
        leadId = next.id;
        tried.push(next.id);
        const result = await backfillContact(client, next.workspace_id, next.id);
        await client.query("commit");
        counts.processed++;
        if (result.created) counts.created++;
        counts.attachedMeetings += result.meetings;
        counts.attachedProposals += result.proposals;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        if (!leadId) throw error;
        failedContacts.add(leadId);
        counts.failed++;
        console.warn(`[deals] backfill for lead ${leadId} failed: ${errorCode(error)}`);
      }
    }
    // Informational: the workspace has nothing left to backfill.
    const done = await client.query(
      `update public.workspaces w set crm_deals_backfilled_at = now()
        where w.crm_deals_backfilled_at is null and ($1::uuid is null or w.id = $1::uuid)
          and not exists (select 1 from public.meetings m where m.workspace_id = w.id and m.deal_id is null)
          and not exists (select 1 from public.proposals p where p.workspace_id = w.id and p.deal_id is null)`,
      [options.workspaceId ?? null],
    );
    counts.workspacesCompleted = done.rowCount ?? 0;
  } finally {
    client.release();
  }
  return counts;
}
