import type { LifecycleState } from "../domain/enums.js";
import type { AgentStatus } from "./rules.js";

/**
 * leads.agent_status state machine (admin actions). The agent itself moves
 * leads to handed_off / stopped in 3C; this only covers what an admin can do.
 *
 *   enroll  none, stopped (non-permanent reason)  → active
 *   pause   active                                → paused
 *   resume  paused, handed_off                    → active
 *   stop    active, paused, handed_off            → stopped
 *
 * enroll and resume also need an eligible lifecycle (active, or
 * long_term_nurture when the workspace nurtures long-term); enroll also needs
 * an email or phone.
 */

export const AGENT_STATUS_ACTIONS = ["enroll", "pause", "resume", "stop"] as const;
export type AgentStatusAction = (typeof AGENT_STATUS_ACTIONS)[number];

/** agent_status_reason codes after which a lead can never be enrolled again. */
export const PERMANENT_STOP_REASONS: readonly string[] = ["asked_to_stop", "not_interested"];

/** agent_status_reason codes written by admin actions. */
export const ADMIN_STATUS_REASONS: Record<AgentStatusAction, string> = {
  enroll: "admin_enroll",
  pause: "admin_pause",
  resume: "admin_resume",
  stop: "admin_stop",
};

export type TransitionRefusal = "already_active" | "permanently_stopped" | "not_eligible" | "no_contact" | "invalid_status";

export interface TransitionContext {
  lifecycleState: LifecycleState;
  nurtureLongTerm: boolean;
  /** The lead's current agent_status_reason. */
  statusReason: string | null;
  hasContact: boolean;
}

export type TransitionResult = { ok: true; to: AgentStatus } | { ok: false; reason: TransitionRefusal; message: string };

const FROM: Record<AgentStatusAction, readonly AgentStatus[]> = {
  enroll: ["none", "stopped"],
  pause: ["active"],
  resume: ["paused", "handed_off"],
  stop: ["active", "paused", "handed_off"],
};
const TO: Record<AgentStatusAction, AgentStatus> = { enroll: "active", pause: "paused", resume: "active", stop: "stopped" };

const refuse = (reason: TransitionRefusal, message: string): TransitionResult => ({ ok: false, reason, message });

export function lifecycleEligible(lifecycle: LifecycleState, nurtureLongTerm: boolean): boolean {
  return lifecycle === "active" || (lifecycle === "long_term_nurture" && nurtureLongTerm);
}

export function canTransition(from: AgentStatus, action: AgentStatusAction, ctx: TransitionContext): TransitionResult {
  if (action === "enroll" && from === "active") return refuse("already_active", "The AI agent already manages this lead.");
  if (!FROM[action].includes(from)) return refuse("invalid_status", `Can't ${action} a lead whose AI agent status is ${from.replace("_", " ")}.`);
  if (action === "enroll" && from === "stopped" && ctx.statusReason && PERMANENT_STOP_REASONS.includes(ctx.statusReason)) {
    return refuse("permanently_stopped", "This lead asked not to be contacted by the AI agent; it can't be enrolled again.");
  }
  if ((action === "enroll" || action === "resume") && !lifecycleEligible(ctx.lifecycleState, ctx.nurtureLongTerm)) {
    return refuse("not_eligible", `The AI agent can't manage a lead whose lifecycle is ${ctx.lifecycleState.replace(/_/g, " ")}.`);
  }
  if (action === "enroll" && !ctx.hasContact) return refuse("no_contact", "The lead has no email or phone.");
  return { ok: true, to: TO[action] };
}
