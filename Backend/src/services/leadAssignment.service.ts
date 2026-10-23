import type { Actor } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { assignmentRulesProblem, resolveOwnerByRules, type AssignmentRule, type RevenueRange } from "../domain/revenue.js";
import { recordAdminAudit } from "./admin-audit.service.js";
import { addTimelineEvent } from "./timeline.service.js";

/** Who owns a new lead and why. `reason` is null for an owner the creator picked explicitly. */
export interface LeadAssignment {
  ownerId: string | null;
  ownerName: string | null;
  reason: string | null;
}

const num = (value: string | null) => (value === null ? null : Number(value));

/**
 * The workspace's active rules (skipping any whose owner has since been
 * deactivated) and its fallback owner (workspaces.default_lead_owner_id, only
 * while that user is active). Load once and reuse for a whole CSV import.
 */
export async function loadAssignmentContext(db: Queryable, workspaceId: string) {
  const rules = await db.query<{ position: number; min_cr: string | null; max_cr: string | null; owner_id: string; full_name: string }>(
    `select r.position, r.min_cr, r.max_cr, r.owner_id, p.full_name
       from public.lead_assignment_rules r
       join public.profiles p on p.id = r.owner_id and p.is_active
      where r.workspace_id = $1 and r.is_active
      order by r.position`,
    [workspaceId],
  );
  const fallback = await db.query<{ id: string | null; full_name: string | null }>(
    `select p.id, p.full_name
       from public.workspaces w
       left join public.profiles p on p.id = w.default_lead_owner_id and p.is_active
      where w.id = $1`,
    [workspaceId],
  );
  const names = new Map(rules.rows.map((r) => [r.owner_id, r.full_name]));
  const fallbackOwner = fallback.rows[0];
  if (fallbackOwner?.id) names.set(fallbackOwner.id, fallbackOwner.full_name!);
  const parsed: AssignmentRule[] = rules.rows.map((r) => ({ position: r.position, minCr: num(r.min_cr), maxCr: num(r.max_cr), ownerId: r.owner_id, isActive: true }));
  return { rules: parsed, fallbackOwnerId: fallbackOwner?.id ?? null, names };
}
export type AssignmentContext = Awaited<ReturnType<typeof loadAssignmentContext>>;

export function assignFromContext(context: AssignmentContext, revenue: RevenueRange | null): LeadAssignment {
  const { ownerId, reason } = resolveOwnerByRules(context.rules, revenue, context.fallbackOwnerId);
  return { ownerId, ownerName: ownerId ? (context.names.get(ownerId) ?? null) : null, reason };
}

/** The owner of a NEW lead from the workspace's revenue rules. Never used to reassign an existing lead. */
export async function assignOwnerForNewLead(db: Queryable, workspaceId: string, revenue: RevenueRange | null): Promise<LeadAssignment> {
  return assignFromContext(await loadAssignmentContext(db, workspaceId), revenue);
}

/** "Lead Assigned" (with the rule reason) or, with no owner, "Lead Unassigned" with the reason. */
export async function recordAssignment(
  db: Queryable,
  leadId: string,
  assignment: LeadAssignment,
  who: Pick<Parameters<typeof addTimelineEvent>[1], "actorId" | "actorName" | "actorSource">,
) {
  if (assignment.ownerId) {
    const owner = assignment.ownerName ?? "Unassigned";
    await addTimelineEvent(db, {
      leadId,
      kind: "system",
      title: "Lead Assigned",
      detail: assignment.reason ? `Owner: ${owner} (${assignment.reason})` : `Owner: ${owner}`,
      ...who,
    });
  } else {
    await addTimelineEvent(db, { leadId, kind: "system", title: "Lead Unassigned", detail: assignment.reason ?? "No owner", ...who });
  }
}

/** One notification to `recipientId`; callers skip the creator themselves. */
export async function notifyOwner(db: Queryable, workspaceId: string, recipientId: string, title: string, detail: string, leadId: string | null, href: string) {
  await db.query(
    `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, lead_id, href)
     values ($1, $2, $3, $4, 'info'::public.notification_kind, $5, $6)`,
    [workspaceId, recipientId, title, detail, leadId, href],
  );
}

// --- Admin rule management ----------------------------------------------------

export interface AssignmentRuleInput {
  position: number;
  minCr: number | null;
  maxCr: number | null;
  ownerId: string;
}

export async function getAssignmentRules(workspaceId: string, db: Queryable = pool) {
  const workspace = await db.query<{ owner_id: string | null; full_name: string | null; is_active: boolean | null }>(
    `select w.default_lead_owner_id as owner_id, p.full_name, p.is_active
       from public.workspaces w
       left join public.profiles p on p.id = w.default_lead_owner_id
      where w.id = $1`,
    [workspaceId],
  );
  const fallback = workspace.rows[0];
  if (!fallback) throw new NotFoundError("Workspace");
  const rules = await db.query<{ id: string; position: number; min_cr: string | null; max_cr: string | null; owner_id: string; full_name: string; is_active: boolean }>(
    `select r.id, r.position, r.min_cr, r.max_cr, r.owner_id, p.full_name, p.is_active
       from public.lead_assignment_rules r
       join public.profiles p on p.id = r.owner_id
      where r.workspace_id = $1
      order by r.position`,
    [workspaceId],
  );
  return {
    rules: rules.rows.map((r) => ({
      id: r.id,
      position: r.position,
      minCr: num(r.min_cr),
      maxCr: num(r.max_cr),
      ownerId: r.owner_id,
      ownerName: r.full_name,
      ownerActive: r.is_active,
    })),
    fallbackOwnerId: fallback.owner_id,
    fallbackOwnerName: fallback.full_name,
    /** False when a fallback owner is saved but has been deactivated (new leads then stay unassigned). */
    fallbackOwnerAvailable: fallback.owner_id === null || Boolean(fallback.is_active),
  };
}

/** Replaces the workspace's whole rule list and its fallback owner in one transaction. */
export async function replaceAssignmentRules(actor: Actor, workspaceId: string, input: { rules: AssignmentRuleInput[]; fallbackOwnerId: string | null }) {
  const problem = assignmentRulesProblem(input.rules);
  if (problem) throw new ValidationError(problem, { field: "rules" });

  await withTransaction(async (db) => {
    const ownerIds = [...new Set([...input.rules.map((rule) => rule.ownerId), ...(input.fallbackOwnerId ? [input.fallbackOwnerId] : [])])];
    const active = await db.query(`select 1 from public.profiles where id = any($1::uuid[]) and is_active`, [ownerIds]);
    if (active.rowCount !== ownerIds.length) throw new ValidationError("Every owner must be an active user.", { field: "ownerId" });

    // Updating the workspace row first also serialises concurrent saves.
    const updated = await db.query(`update public.workspaces set default_lead_owner_id = $2 where id = $1`, [workspaceId, input.fallbackOwnerId]);
    if (!updated.rowCount) throw new NotFoundError("Workspace");
    await db.query(`delete from public.lead_assignment_rules where workspace_id = $1`, [workspaceId]);
    for (const rule of [...input.rules].sort((a, b) => a.position - b.position)) {
      await db.query(
        `insert into public.lead_assignment_rules (workspace_id, position, min_cr, max_cr, owner_id, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $6)`,
        [workspaceId, rule.position, rule.minCr, rule.maxCr, rule.ownerId, actor.id],
      );
    }
    await recordAdminAudit(db, actor, "workspace.assignment_rules_replaced", "workspace", workspaceId, {
      rules: input.rules,
      fallbackOwnerId: input.fallbackOwnerId,
    });
  });
  return getAssignmentRules(workspaceId);
}
