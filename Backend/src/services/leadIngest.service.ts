import type { Queryable } from "../dto.js";
import { onAgentEvent } from "./agentEvents.service.js";
import { addDaysIso } from "../dto.js";
import { ValidationError } from "../errors.js";
import { formatSubmissionDetail, normalizeWebsiteForm, type NormalizedWebsiteForm, type RawWebsiteForm } from "../domain/websiteForm.js";
import { insertLead, validateLeadFields } from "./leads.service.js";
import { assignOwnerForNewLead, recordAssignment, type LeadAssignment } from "./leadAssignment.service.js";
import type { RevenueRange } from "../domain/revenue.js";
import { createTask } from "./tasks.service.js";
import { addTimelineEvent, SYSTEM_ACTOR } from "./timeline.service.js";

export type IngestOutcome =
  | { status: "created"; leadId: string }
  | { status: "duplicate"; leadId: string }
  | { status: "rejected"; reason: string };

const CREATED_BY_LABEL = "Website form";
const SUBMISSION_TITLE = "Website form submission";
const RESUBMISSION_TITLE = "Website form submitted again";
/** An identical resubmission inside this window (double click, website retry) is absorbed silently. */
const REPEAT_WINDOW_MINUTES = 10;

/**
 * Serializes concurrent submissions for the same person. There is no unique
 * index on lead email/phone (and no migration is allowed for this feature), so
 * two simultaneous requests could otherwise both miss each other's insert and
 * create twin leads. Keys are locked in sorted order so two requests that
 * share both an email and a phone can never deadlock. Transaction-scoped:
 * released automatically on commit/rollback. Must run inside a transaction.
 */
async function lockSubmitter(db: Queryable, workspaceId: string, form: NormalizedWebsiteForm) {
  const keys = [
    ...(form.email ? [`${workspaceId}:email:${form.email}`] : []),
    ...(form.phoneE164 ? [`${workspaceId}:phone:${form.phoneE164}`] : []),
  ].sort();
  for (const key of keys) {
    await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
}

/**
 * The new lead's owner from the workspace's revenue rules and fallback owner.
 * A savepoint keeps a failed lookup from aborting the whole transaction: the
 * lead is still created, unassigned, and says why.
 */
async function resolveOwner(db: Queryable, workspaceId: string, revenue: RevenueRange | null): Promise<LeadAssignment> {
  await db.query("savepoint resolve_lead_owner");
  try {
    const assignment = await assignOwnerForNewLead(db, workspaceId, revenue);
    await db.query("release savepoint resolve_lead_owner");
    return assignment;
  } catch (err) {
    await db.query("rollback to savepoint resolve_lead_owner");
    console.warn(JSON.stringify({ event: "website_lead_owner_lookup_failed", message: err instanceof Error ? err.message : String(err) }));
    return { ownerId: null, ownerName: null, reason: "Assignment rules unavailable - unassigned" };
  }
}

async function findExistingLead(db: Queryable, workspaceId: string, form: NormalizedWebsiteForm) {
  const result = await db.query<{ id: string; lifecycle_state: string; owner_id: string | null }>(
    `select id, lifecycle_state, owner_id
       from public.leads
      where workspace_id = $1
        and lifecycle_state <> 'merged'
        and (($2::text is not null and lower(email) = $2::text)
          or ($3::text is not null and phone_e164 = $3::text))
      order by (case when $2::text is not null and lower(email) = $2::text then 0 else 1 end), created_at desc
      limit 1`,
    [workspaceId, form.email, form.phoneE164],
  );
  return result.rows[0] ?? null;
}

/**
 * Notifies the lead's owner when it has one (and is active), otherwise every
 * active CRM user (salespeople and admins) so an unassigned lead is still seen.
 */
async function notifyAboutLead(db: Queryable, workspaceId: string, leadId: string, ownerId: string | null, title: string, detail: string) {
  const result = await db.query(
    `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, lead_id, href)
     select $1, p.id, $2, $3, 'info'::public.notification_kind, $4, $5
       from public.profiles p
      where p.is_active = true
        and ($6::uuid is null or p.id = $6::uuid)`,
    [workspaceId, title, detail, leadId, `/leads/${leadId}`, ownerId],
  );
  // The owner was deactivated: tell everyone instead.
  if (ownerId && !result.rowCount) await notifyAboutLead(db, workspaceId, leadId, null, title, detail);
}

function displayName(form: NormalizedWebsiteForm): string {
  return `${form.firstName} ${form.lastName}`.trim();
}

function submissionMetadata(form: NormalizedWebsiteForm): Record<string, unknown> {
  return {
    channel: "website_form",
    industry: form.industry,
    revenueRange: form.revenueRange,
    diagnosisIssue: form.diagnosisIssue,
    invalidPhone: form.invalidPhone,
    rawMessage: form.message,
  };
}

/**
 * Creates (or, for a known person, annotates) a lead from a public website
 * form submission. Self-contained on purpose: it only *calls* existing
 * helpers and never modifies createLead/importLeads, so the in-app flows are
 * untouched. Differences from an in-app createLead, all deliberate:
 *  - no acting user: events are written as SYSTEM and created_by is null. The
 *    owner comes from the workspace's revenue rules (the form's "Revenue
 *    range:" line), else its fallback owner; with neither the lead stays
 *    unassigned and every active user is notified;
 *  - no workflow enrollment (no automatic email/WhatsApp to the visitor);
 *  - a repeat submitter updates the existing lead's timeline instead of
 *    creating a second lead, and never changes its stage/lifecycle/DNC state.
 *
 * Must be called inside a transaction so the lead, its events, its task and
 * the notifications are all-or-nothing.
 */
export async function ingestWebsiteLead(db: Queryable, workspaceId: string, raw: RawWebsiteForm): Promise<IngestOutcome> {
  const form = normalizeWebsiteForm(raw);
  if (!form.email && !form.phoneE164) {
    return { status: "rejected", reason: "A valid email address or phone number is required." };
  }

  await lockSubmitter(db, workspaceId, form);

  const detail = formatSubmissionDetail(form);
  const existing = await findExistingLead(db, workspaceId, form);

  if (existing) {
    const repeat = await db.query(
      `select 1 from public.timeline_events
        where lead_id = $1
          and title in ($2, $3)
          and detail = $4
          and created_at > now() - make_interval(mins => $5::int)
        limit 1`,
      [existing.id, SUBMISSION_TITLE, RESUBMISSION_TITLE, detail, REPEAT_WINDOW_MINUTES],
    );
    if (repeat.rowCount) return { status: "duplicate", leadId: existing.id };

    await addTimelineEvent(db, {
      leadId: existing.id,
      kind: "system",
      title: RESUBMISSION_TITLE,
      detail,
      metadata: submissionMetadata(form),
      ...SYSTEM_ACTOR,
    });
    await db.query(`update public.leads set last_activity_at = now() where id = $1`, [existing.id]);

    const stateNote = existing.lifecycle_state === "active" ? "" : ` This lead is currently "${existing.lifecycle_state}" - nothing was changed automatically.`;
    await notifyAboutLead(
      db,
      workspaceId,
      existing.id,
      existing.owner_id,
      "Website form submitted again",
      `${displayName(form)} (${form.company}) submitted the website form again.${stateNote}`,
    );
    return { status: "duplicate", leadId: existing.id };
  }

  let fields;
  try {
    fields = validateLeadFields({
      firstName: form.firstName,
      lastName: form.lastName,
      company: form.company,
      industry: form.industry ?? undefined,
      email: form.email ?? undefined,
      phone: form.phone ?? undefined,
      source: "website",
      revenueRange: form.revenueRange ?? undefined,
    });
  } catch (err) {
    if (err instanceof ValidationError) return { status: "rejected", reason: err.message };
    throw err;
  }

  const owner = await resolveOwner(db, workspaceId, fields.revenue);
  const leadId = await insertLead(db, workspaceId, fields, owner.ownerId, null, CREATED_BY_LABEL);

  await addTimelineEvent(db, { leadId, kind: "system", title: "Lead Created", detail: "Source: website (website form)", ...SYSTEM_ACTOR });
  await recordAssignment(db, leadId, owner, SYSTEM_ACTOR);
  await addTimelineEvent(db, {
    leadId,
    kind: "system",
    title: SUBMISSION_TITLE,
    detail,
    metadata: submissionMetadata(form),
    ...SYSTEM_ACTOR,
  });

  // Same rule as every other lead: a new active lead always has a next
  // action, owned by the lead's owner (or unassigned if there is none).
  await createTask(db, null, workspaceId, {
    leadId,
    ownerId: owner.ownerId,
    ownerName: owner.ownerName,
    type: "call",
    title: "First call",
    dueAt: addDaysIso(0),
    origin: "manual",
  });

  await notifyAboutLead(db, workspaceId, leadId, owner.ownerId, "New website lead", `${displayName(form)} (${form.company}) submitted the website form.`);
  await onAgentEvent(db, { workspaceId, leadId, event: "lead_created" });
  return { status: "created", leadId };
}
