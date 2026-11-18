/**
 * REL-1: which leads are worked automatically, and the per-lead switch (one contact or many). Every SQL query of the
 * feature lives here; the rule is pure in domain/automation.ts (isAutomated). Automatic jobs filter with AUTOMATED_SQL;
 * opting in never replays the past (NOT_BEFORE_OPT_IN_SQL for escalations), switching off pauses the lead's workflow
 * runs (they stay paused when switched on again: resume by hand).
 */
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { ForbiddenError, ValidationError } from "../errors.js";
import { MAX_AUTOMATION_BATCH } from "../domain/automation.js";
import { recordAdminAudit } from "./admin-audit.service.js";

/** SQL mirror of isAutomated() for lead alias `l` (any query; reads the workspace's cutoff by primary key). */
export const AUTOMATED_SQL = (l = "l") =>
  `coalesce(${l}.automation_enabled, ${l}.created_at >= (select a.automation_since from public.agent_settings a where a.workspace_id = ${l}.workspace_id))`;

/** No back-dated escalation: for a lead switched on by a person, only things at or after that moment (`at` = SQL time). */
export const NOT_BEFORE_OPT_IN_SQL = (l: string, at: string) => `(${l}.automation_enabled is not true or ${at} >= ${l}.automation_set_at)`;

export async function isLeadAutomated(db: Queryable, leadId: string): Promise<boolean> {
  return (await db.query<{ automated: boolean }>(`select ${AUTOMATED_SQL("l")} as automated from public.leads l where l.id = $1`, [leadId])).rows[0]?.automated ?? false;
}

export interface LeadAutomationState {
  automated: boolean;
  /** null = decided by the go-live cutoff. */
  enabled: boolean | null;
  setAt: string | null;
  setByName: string | null;
  since: string;
}

/** What the contact page's Automation switch shows. */
export async function getLeadAutomation(db: Queryable, workspaceId: string, leadId: string): Promise<LeadAutomationState | null> {
  const row = (
    await db.query<{ automated: boolean; enabled: boolean | null; set_at: Date | null; set_by_name: string | null; since: Date }>(
      `select ${AUTOMATED_SQL("l")} as automated, l.automation_enabled as enabled, l.automation_set_at as set_at, p.full_name as set_by_name,
              (select a.automation_since from public.agent_settings a where a.workspace_id = l.workspace_id) as since
         from public.leads l left join public.profiles p on p.id = l.automation_set_by
        where l.id = $1 and l.workspace_id = $2`,
      [leadId, workspaceId],
    )
  ).rows[0];
  if (!row) return null;
  return { automated: row.automated, enabled: row.enabled, setAt: row.set_at?.toISOString() ?? null, setByName: row.set_by_name, since: row.since.toISOString() };
}

const SWITCH_SQL = `update public.leads l set automation_enabled = $3, automation_set_at = now(), automation_set_by = $4
  where l.workspace_id = $1 and l.id = any($2::uuid[]) and l.merged_into_lead_id is null
    and ($5::boolean or l.owner_id = $4)
    and ${AUTOMATED_SQL("l")} is distinct from $3
  returning l.id`;

const TIMELINE_SQL = `insert into public.timeline_events (lead_id, event_kind, title, detail, actor_id, actor_name, actor_source)
  select id, 'automation', $2, $3, $4, $5, 'manual' from unnest($1::uuid[]) as id`;

/** Switching off pauses the lead's running / waiting workflow runs and their pending steps (as a run pause does). */
const PAUSE_RUNS_SQL = `with runs as (
    update public.workflow_runs set status = 'paused' where lead_id = any($1::uuid[]) and status in ('running', 'waiting') returning id)
  update public.scheduled_actions set status = 'paused' where workflow_run_id in (select id from runs) and status in ('pending', 'due')`;

export interface AutomationSwitchResult {
  changed: string[];
  /** Asked for but not changed: already in that state, not found, merged, or (salespeople) not their contact. */
  unchanged: number;
}

/**
 * Rule 2: an admin, or the owner for their own contacts, switches automation on / off (inside the caller's
 * transaction). One timeline row per changed contact and one admin-audit row per request.
 */
export async function switchAutomation(
  db: Queryable,
  actor: Actor,
  workspaceId: string,
  leadIds: string[],
  enabled: boolean,
  opts: { reason?: string; audit?: Record<string, unknown> } = {},
): Promise<AutomationSwitchResult> {
  const ids = [...new Set(leadIds)];
  if (ids.length > MAX_AUTOMATION_BATCH) throw new ValidationError(`At most ${MAX_AUTOMATION_BATCH} contacts at a time.`);
  const changed = (await db.query<{ id: string }>(SWITCH_SQL, [workspaceId, ids, enabled, actor.id, actor.role === "admin"])).rows.map((r) => r.id);
  if (changed.length) {
    await db.query(TIMELINE_SQL, [
      changed,
      enabled ? "Automation switched on" : "Automation switched off",
      opts.reason ?? (enabled ? "Automatic follow-up starts from the next worker run (nothing from the past is replayed)." : "Automatic tasks, reminders and messages stop; workflow runs are paused. Sent messages stay sent."),
      actor.id,
      actor.fullName,
    ]);
    if (!enabled) await db.query(PAUSE_RUNS_SQL, [changed]);
  }
  await recordAdminAudit(db, actor, enabled ? "contacts.automation_on" : "contacts.automation_off", "lead", ids.length === 1 ? ids[0] : null, {
    workspaceId,
    asked: ids.length,
    changed: changed.length,
    ...opts.audit,
  });
  return { changed, unchanged: ids.length - changed.length };
}

/** One contact: 403 when a salesperson isn't the owner (instead of a silent "unchanged"). */
export async function assertCanSwitch(db: Queryable, actor: Actor, workspaceId: string, leadId: string): Promise<void> {
  if (actor.role === "admin") return;
  const owner = (await db.query<{ owner_id: string | null }>(`select owner_id from public.leads where id = $1 and workspace_id = $2`, [leadId, workspaceId])).rows[0];
  if (owner && owner.owner_id !== actor.id) throw new ForbiddenError("Only an admin or the contact's owner can change its automation.");
}

/** Rule 2: a manual AI / workflow enrolment of a non-automated lead switches it on (no-op when already automated). */
export async function switchOnForEnrolment(db: Queryable, actor: Actor, workspaceId: string, leadId: string, what: string): Promise<void> {
  const changed = (await db.query<{ id: string }>(SWITCH_SQL, [workspaceId, [leadId], true, actor.id, true])).rows;
  if (changed.length) await db.query(TIMELINE_SQL, [[leadId], "Automation switched on", `Switched on by ${what}.`, actor.id, actor.fullName]);
}
