/**
 * When an event should wake the agent for a lead. Rep activity (calls, notes,
 * meeting outcomes) waits rep_quiet_hours so the agent doesn't talk over the
 * rep; other events wake it shortly after.
 */

export const AGENT_WAKE_EVENTS = [
  "lead_created",
  "call_logged",
  "note_added",
  "meeting_booked",
  "meeting_rescheduled",
  "meeting_cancelled",
  "meeting_outcome",
  "proposal_status",
] as const;
export type AgentWakeEvent = (typeof AGENT_WAKE_EVENTS)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** null = wait rep_quiet_hours. */
const DELAY_MINUTES: Record<AgentWakeEvent, number | null> = {
  lead_created: 5,
  call_logged: null,
  note_added: null,
  meeting_booked: 10,
  meeting_rescheduled: 10,
  meeting_cancelled: 10,
  meeting_outcome: null,
  proposal_status: 10,
};

/** The wakeup reason is the event name (agent_wakeups.reason accepts each of them). */
export function wakeFor(event: AgentWakeEvent, now: Date, settings: { rep_quiet_hours: number }): { reason: AgentWakeEvent; dueAt: Date } {
  const minutes = DELAY_MINUTES[event];
  const delay = minutes === null ? settings.rep_quiet_hours * HOUR_MS : minutes * MINUTE_MS;
  return { reason: event, dueAt: new Date(now.getTime() + delay) };
}
