/**
 * LL-1 safety net (pure rules): when a lead needs a next action, what that task is, and who is
 * responsible for it. The SQL that reads these facts lives in services/nextAction.service.ts.
 */
import type { AutomationMode, LifecycleState, TaskType } from "./enums.js";

const DAY_MS = 86_400_000;

export interface NextActionFacts {
  lifecycle: LifecycleState;
  openTasks: number;
  futureMeeting: boolean;
  automationMode: AutomationMode;
  /** An active workflow run (running / waiting) with a pending step. */
  workflowStepPending: boolean;
  ai: {
    status: "none" | "active" | "paused" | "handed_off" | "stopped";
    /** effectiveMode === 'live' (shadow never sends, so it never covers a lead). */
    live: boolean;
    touches: number;
    maxTouches: number;
  };
}

/** (a) a workflow step will still run: lifecycle active and automation not manual/paused/stopped (they skip every step). */
export function coveredByWorkflow(f: NextActionFacts): boolean {
  return f.workflowStepPending && f.lifecycle === "active" && f.automationMode === "active";
}

/** (b) the AI can still send: active, live, touches left (not waiting only because every journey message is used). */
export function coveredByAi(f: NextActionFacts): boolean {
  return f.ai.status === "active" && f.ai.live && f.ai.touches < f.ai.maxTouches;
}

/** Rule 2: active / long-term nurture, no open task, no future meeting, not covered by automation. */
export function needsNextAction(f: NextActionFacts): boolean {
  if (f.lifecycle !== "active" && f.lifecycle !== "long_term_nurture") return false;
  if (f.openTasks > 0 || f.futureMeeting) return false;
  return !coveredByWorkflow(f) && !coveredByAi(f);
}

export const DECIDE_NEXT_STEP_TITLE = "Decide the next step";
export const PLAN_REENGAGEMENT_TITLE = "Plan re-engagement";
export const NO_NEXT_ACTION_TIMELINE_TITLE = "No next action — task created";

/** Rule 3: the sweep's task. Long-term nurture: re_engage due +45 d (LL-3 makes it reason-based). */
export function sweepTask(lifecycle: LifecycleState, now: Date): { type: TaskType; title: string; dueAt: Date } {
  return lifecycle === "long_term_nurture"
    ? { type: "re_engage", title: PLAN_REENGAGEMENT_TITLE, dueAt: new Date(now.getTime() + 45 * DAY_MS) }
    : { type: "follow_up", title: DECIDE_NEXT_STEP_TITLE, dueAt: now };
}

export interface ResponsibleInput {
  owner: { id: string; name: string | null; active: boolean; member: boolean } | null;
  /** The workspace's active admins (WORKSPACE_ADMIN_IDS_SQL). */
  adminIds: string[];
}

export interface Responsible {
  /** The task's owner: the lead owner when responsible, else null (unowned task). */
  ownerId: string | null;
  ownerName: string | null;
  /** Who gets the bell. */
  notify: string[];
}

/** Rule 1: the owner if an active member of the workspace, otherwise the workspace's active admins (task unowned). */
export function resolveResponsible({ owner, adminIds }: ResponsibleInput): Responsible {
  if (owner && owner.active && owner.member) return { ownerId: owner.id, ownerName: owner.name, notify: [owner.id] };
  return { ownerId: null, ownerName: null, notify: [...new Set(adminIds)] };
}

/** Rule 3 batching: one bell per person per tick with the number of leads they were told about. */
export function batchBells(items: { workspaceId: string; notify: string[] }[]): { workspaceId: string; recipientId: string; count: number }[] {
  const counts = new Map<string, { workspaceId: string; recipientId: string; count: number }>();
  for (const item of items) {
    for (const recipientId of new Set(item.notify)) {
      const key = `${item.workspaceId}:${recipientId}`;
      const entry = counts.get(key) ?? { workspaceId: item.workspaceId, recipientId, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()];
}

export const sweepBellTitle = (count: number) => (count === 1 ? "1 lead needs a next step" : `${count} leads need a next step`);
