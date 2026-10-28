import type { Actor } from "../authMiddleware.js";
import { withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { InvalidTransitionError, NotFoundError } from "../errors.js";
import type { LifecycleState } from "../domain/enums.js";
import type { AgentMode, AgentStatus } from "../agent/rules.js";
import { ADMIN_STATUS_REASONS, canTransition, type AgentStatusAction, type TransitionRefusal } from "../agent/status.js";
import { cancelPendingWakeups, enqueueWakeup, type EnqueueOutcome, type WakeupReason } from "./agentWakeups.service.js";
import { actorEvent, addTimelineEvent } from "./timeline.service.js";
import { getLeadRowOr404 } from "./leads.service.js";
import { cancelWorkflowsIfLive } from "./agentSendState.service.js";

/**
 * Admin changes to leads.agent_status. Touches only agent_* columns,
 * agent_wakeups and the timeline — never workflows, runs or automation_mode.
 */

export const MAX_ENROLL_BATCH = 500;

const TITLES: Record<AgentStatusAction, string> = {
  enroll: "AI Agent Enrolled",
  pause: "AI Agent Paused",
  resume: "AI Agent Resumed",
  stop: "AI Agent Stopped",
};
const WAKE_REASONS: Partial<Record<AgentStatusAction, WakeupReason>> = { enroll: "enrolled", resume: "resumed" };

interface AgentLeadRow {
  id: string;
  lifecycle_state: LifecycleState;
  agent_status: AgentStatus;
  agent_status_reason: string | null;
  has_contact: boolean;
}

type ApplyResult = { ok: true; wakeup: EnqueueOutcome | "cancelled" } | { ok: false; reason: TransitionRefusal | "not_found"; message: string };

async function loadSettings(db: Queryable, workspaceId: string) {
  const result = await db.query<{ mode: AgentMode; nurture_long_term: boolean }>(
    `select mode, nurture_long_term from public.agent_settings where workspace_id = $1`,
    [workspaceId],
  );
  return result.rows[0] ?? { mode: "off" as const, nurture_long_term: false };
}

async function applyAction(
  client: Queryable,
  actor: Actor,
  workspaceId: string,
  leadId: string,
  action: AgentStatusAction,
  settings: { nurture_long_term: boolean },
  note?: string,
): Promise<ApplyResult> {
  const lead = (
    await client.query<AgentLeadRow>(
      `select id, lifecycle_state, agent_status, agent_status_reason,
              (email is not null or phone_e164 is not null) as has_contact
         from public.leads where id = $1 and workspace_id = $2 for update`,
      [leadId, workspaceId],
    )
  ).rows[0];
  if (!lead) return { ok: false, reason: "not_found", message: "Lead not found." };

  const check = canTransition(lead.agent_status, action, {
    lifecycleState: lead.lifecycle_state,
    nurtureLongTerm: settings.nurture_long_term,
    statusReason: lead.agent_status_reason,
    hasContact: lead.has_contact,
  });
  if (!check.ok) return check;

  const reason = ADMIN_STATUS_REASONS[action];
  await client.query(
    `update public.leads set agent_status = $2, agent_status_reason = $3, agent_status_changed_at = now() where id = $1`,
    [leadId, check.to, reason],
  );
  await addTimelineEvent(client, {
    leadId,
    kind: "automation",
    title: TITLES[action],
    detail: note?.trim() || null,
    ...actorEvent(actor),
    metadata: { agentStatusFrom: lead.agent_status, agentStatusTo: check.to, reason },
  });

  // E2 rule 9: enrolled while live → out of its workflows.
  if (action === "enroll") await cancelWorkflowsIfLive(client, workspaceId, leadId);
  const wakeReason = WAKE_REASONS[action];
  if (wakeReason) return { ok: true, wakeup: await enqueueWakeup(client, { workspaceId, leadId, reason: wakeReason, dueAt: new Date() }) };
  await cancelPendingWakeups(client, leadId, reason);
  return { ok: true, wakeup: "cancelled" };
}

export type EnrollResult =
  | { leadId: string; result: "enrolled" }
  | { leadId: string; result: "skipped"; reason: "not_found" | "not_eligible" | "already_active" | "permanently_stopped" | "no_contact" }
  | { leadId: string; result: "failed"; message: string };

/**
 * Enrolls up to 500 leads; each in its own transaction so one bad lead
 * doesn't fail the batch. Leads in another workspace are 'not_found'.
 */
export async function enrollLeads(db: Queryable, actor: Actor, workspaceId: string, leadIds: string[]): Promise<EnrollResult[]> {
  const settings = await loadSettings(db, workspaceId);
  const results: EnrollResult[] = [];
  for (const leadId of [...new Set(leadIds)]) {
    try {
      const outcome = await withTransaction((client) => applyAction(client, actor, workspaceId, leadId, "enroll", settings));
      if (outcome.ok) results.push({ leadId, result: "enrolled" });
      // paused / handed_off leads are already enrolled: resume them instead.
      else results.push({ leadId, result: "skipped", reason: outcome.reason === "invalid_status" ? "not_eligible" : outcome.reason });
    } catch (error) {
      console.error(`[agent] enroll failed for lead ${leadId}:`, error);
      results.push({ leadId, result: "failed", message: "Couldn't enroll this lead." });
    }
  }
  return results;
}

/** pause / resume / stop one lead inside the caller's transaction. Throws 404 / 422 on refusal. Returns the lead row. */
async function changeLeadAgentStatus(
  client: Queryable,
  actor: Actor,
  workspaceId: string,
  leadId: string,
  action: Exclude<AgentStatusAction, "enroll">,
  note?: string,
) {
  const outcome = await applyAction(client, actor, workspaceId, leadId, action, await loadSettings(client, workspaceId), note);
  if (!outcome.ok) {
    if (outcome.reason === "not_found") throw new NotFoundError("Lead");
    throw new InvalidTransitionError(outcome.message);
  }
  return getLeadRowOr404(client, workspaceId, leadId);
}

export const pauseLead = (client: Queryable, actor: Actor, workspaceId: string, leadId: string) =>
  changeLeadAgentStatus(client, actor, workspaceId, leadId, "pause");
export const resumeLead = (client: Queryable, actor: Actor, workspaceId: string, leadId: string) =>
  changeLeadAgentStatus(client, actor, workspaceId, leadId, "resume");
export const stopLead = (client: Queryable, actor: Actor, workspaceId: string, leadId: string, note?: string) =>
  changeLeadAgentStatus(client, actor, workspaceId, leadId, "stop", note);

/**
 * E2: an admin marks (or unmarks) a contact as an AI live test contact. Any lifecycle.
 * Marking a contact that is then AI-live takes it out of its workflows (rule 9);
 * unmarking cancels its queued AI sends at the send-time re-check.
 */
export async function setLiveTest(client: Queryable, actor: Actor, workspaceId: string, leadId: string, enabled: boolean): Promise<void> {
  const lead = (await client.query<{ agent_live_test: boolean }>(`select agent_live_test from public.leads where id = $1 and workspace_id = $2 for update`, [leadId, workspaceId])).rows[0];
  if (!lead) throw new NotFoundError("Lead");
  if (lead.agent_live_test === enabled) return;
  await client.query(`update public.leads set agent_live_test = $2, agent_live_test_by = $3, agent_live_test_at = now() where id = $1`, [leadId, enabled, actor.id]);
  await addTimelineEvent(client, {
    leadId,
    kind: "automation",
    title: enabled ? `Marked as AI live test by ${actor.fullName}` : `AI live test removed by ${actor.fullName}`,
    ...actorEvent(actor),
    metadata: { agentLiveTest: enabled },
  });
  if (enabled) await cancelWorkflowsIfLive(client, workspaceId, leadId);
}

/** Queues a wakeup due now. 'skipped' when the agent is off for the workspace. Not a status change, so no timeline event. */
export async function wakeNow(client: Queryable, workspaceId: string, leadId: string): Promise<{ wakeup: EnqueueOutcome }> {
  const lead = await getLeadRowOr404(client, workspaceId, leadId);
  if (lead.agent_status !== "active") {
    throw new InvalidTransitionError("Only leads the AI agent is actively managing can be woken.");
  }
  return { wakeup: await enqueueWakeup(client, { workspaceId, leadId, reason: "manual_wake", dueAt: new Date() }) };
}
