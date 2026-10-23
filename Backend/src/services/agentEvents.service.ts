import type { Queryable } from "../dto.js";
import type { LifecycleState } from "../domain/enums.js";
import type { AgentMode, AgentStatus } from "../agent/rules.js";
import { AGENT_ACTOR_NAME } from "../agent/constants.js";
import { canTransition } from "../agent/status.js";
import { AGENT_WAKE_EVENTS, wakeFor, type AgentWakeEvent } from "../agent/wakePolicy.js";
import { cancelPendingWakeups, enqueueWakeup } from "./agentWakeups.service.js";
import { addTimelineEvent } from "./timeline.service.js";

/**
 * CRM events the AI agent reacts to. Called at the END of the caller's work,
 * inside its transaction, so it sees the final stage / lifecycle. Status
 * effects apply in every mode (so turning the agent on later never acts on a
 * lead that replied or booked a meeting meanwhile); auto-enroll and wakeups
 * only when the mode isn't off (enqueueWakeup checks that itself). Lifecycle
 * stops are done by the migration 026 trigger, not here. Never touches
 * workflows, runs or automation_mode. Nothing is sent.
 */
export type AgentEvent = AgentWakeEvent | "whatsapp_inbound";

export interface AgentEventInput {
  workspaceId: string;
  leadId: string;
  event: AgentEvent;
  /** Ids only (e.g. meetingId), never message content. */
  payload?: Record<string, unknown>;
}

const AGENT_ACTOR = { actorId: null, actorName: AGENT_ACTOR_NAME, actorSource: "automation" as const };
const UPCOMING_MEETING_STATUSES = ["tentative", "scheduled", "confirmed", "rescheduled"];

/** Never throws: any failure is rolled back to a savepoint and logged, so the caller's operation still commits. */
export async function onAgentEvent(client: Queryable, input: AgentEventInput): Promise<void> {
  try {
    await client.query("savepoint agent_event");
  } catch (error) {
    // Not inside a transaction (or it's already aborted): nothing safe to do.
    console.warn(`[agent] ${input.event} for lead ${input.leadId} skipped: ${errorCode(error)}`);
    return;
  }
  try {
    await handleEvent(client, input);
    await client.query("release savepoint agent_event");
  } catch (error) {
    await client.query("rollback to savepoint agent_event").catch(() => undefined);
    await client.query("release savepoint agent_event").catch(() => undefined);
    console.warn(`[agent] ${input.event} for lead ${input.leadId} failed: ${errorCode(error)}`);
  }
}

// Codes / class names only: a pg message can quote row values.
function errorCode(error: unknown): string {
  const e = error as { code?: string; name?: string };
  return e?.code ?? e?.name ?? "unknown error";
}

async function handleEvent(client: Queryable, { workspaceId, leadId, event, payload }: AgentEventInput) {
  const settings = (
    await client.query<{ mode: AgentMode; nurture_long_term: boolean; rep_quiet_hours: number; auto_enroll_new_leads: boolean }>(
      `select mode, nurture_long_term, rep_quiet_hours, auto_enroll_new_leads from public.agent_settings where workspace_id = $1`,
      [workspaceId],
    )
  ).rows[0];
  if (!settings) return;

  const lead = (
    await client.query<{ agent_status: AgentStatus; agent_status_reason: string | null; lifecycle_state: LifecycleState; has_contact: boolean }>(
      `select agent_status, agent_status_reason, lifecycle_state, (email is not null or phone_e164 is not null) as has_contact
         from public.leads where id = $1 and workspace_id = $2 for update`,
      [leadId, workspaceId],
    )
  ).rows[0];
  if (!lead) return;

  const setStatus = async (to: AgentStatus, reason: string, title: string) => {
    await client.query(
      `update public.leads set agent_status = $2, agent_status_reason = $3, agent_status_changed_at = now() where id = $1`,
      [leadId, to, reason],
    );
    await addTimelineEvent(client, {
      leadId,
      kind: "automation",
      title,
      ...AGENT_ACTOR,
      metadata: { agentStatusFrom: lead.agent_status, agentStatusTo: to, reason, event },
    });
    if (to !== "active") await cancelPendingWakeups(client, leadId, reason);
  };
  const transitionCtx = {
    lifecycleState: lead.lifecycle_state,
    nurtureLongTerm: settings.nurture_long_term,
    statusReason: lead.agent_status_reason,
    hasContact: lead.has_contact,
  };

  if (event === "lead_created" && settings.mode !== "off" && settings.auto_enroll_new_leads && lead.agent_status === "none") {
    if (canTransition("none", "enroll", transitionCtx).ok) await setStatus("active", "auto_enroll", "AI Agent Enrolled");
  } else if (event === "meeting_booked" && lead.agent_status === "active") {
    await setStatus("paused", "meeting_booked", "AI Agent Paused");
  } else if (
    (event === "meeting_outcome" || event === "meeting_cancelled") &&
    lead.agent_status === "paused" &&
    lead.agent_status_reason === "meeting_booked" &&
    canTransition("paused", "resume", transitionCtx).ok
  ) {
    const upcoming = await client.query(
      `select 1 from public.meetings where lead_id = $1 and status = any($2::meeting_status[]) and scheduled_at > now() limit 1`,
      [leadId, UPCOMING_MEETING_STATUSES],
    );
    if (!upcoming.rowCount) await setStatus("active", "meeting_done", "AI Agent Resumed");
  } else if (event === "whatsapp_inbound" && (lead.agent_status === "active" || lead.agent_status === "paused")) {
    await setStatus("handed_off", "lead_replied", "AI Agent Handed Off");
  }

  if ((AGENT_WAKE_EVENTS as readonly string[]).includes(event)) {
    const { reason, dueAt } = wakeFor(event as AgentWakeEvent, new Date(), settings);
    // A no-op unless the lead is (now) active.
    await enqueueWakeup(client, { workspaceId, leadId, reason, dueAt, payload });
  }
}
