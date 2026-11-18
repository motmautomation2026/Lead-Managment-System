/**
 * REL-1: which leads are worked automatically (AI, workflow auto-enrol, safety-net sweep, reminders, escalations,
 * the call ladder, recovery, deal follow-ups). Pure; the SQL mirror is AUTOMATED_SQL in
 * services/leadAutomation.service.ts — keep the two in step.
 */
export interface AutomationLead {
  createdAt: Date;
  /** null = the workspace cutoff decides; true / false = switched on / off by a person. */
  automationEnabled: boolean | null;
}

export interface AutomationWorkspace {
  /** agent_settings.automation_since: the go-live cutoff. */
  automationSince: Date;
}

export function isAutomated(lead: AutomationLead, workspace: AutomationWorkspace): boolean {
  return lead.automationEnabled ?? lead.createdAt.getTime() >= workspace.automationSince.getTime();
}

/** Bulk switch: at most this many contacts per request (ids or a filtered set). */
export const MAX_AUTOMATION_BATCH = 2000;
