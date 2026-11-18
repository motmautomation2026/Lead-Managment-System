import type { DealStage, IdName } from "./crm";
import type { MeetingListItem, TaskListItem } from "./work";
import type {
  Run,
  RunStatus,
  ScheduledAction,
  ScheduledActionStatus,
  StepAction,
} from "./workflow";

/** GET /runs/list row (C6b): the Run + its contact, workflow and current step's action. */
export type RunListItem = Run & {
  contact: IdName;
  workflow: IdName;
  currentStepAction: StepAction | null;
};

/** GET /scheduled-actions/list row ("Scheduled steps"). */
export type ScheduledActionListItem = ScheduledAction & {
  contact: IdName;
  workflow: IdName;
  /** 0-based order of the step in its version (null if the step was deleted). */
  stepOrder: number | null;
};

export interface RunListParams {
  workflowId?: string | undefined;
  status?: RunStatus[] | undefined;
  contactId?: string | undefined;
  startedFrom?: string | undefined;
  startedTo?: string | undefined;
  q?: string | undefined;
  sort?: string | undefined;
  limit?: number | undefined;
}

export interface ScheduledActionListParams {
  status?: ScheduledActionStatus[] | undefined;
  runId?: string | undefined;
  workflowId?: string | undefined;
  contactId?: string | undefined;
  dueFrom?: string | undefined;
  dueTo?: string | undefined;
  q?: string | undefined;
  sort?: string | undefined;
  limit?: number | undefined;
}

/** GET /home/summary: the signed-in user's day (IST, computed by the backend). */
export interface HomeSummary {
  tasks: { overdue: number; dueToday: number; next: TaskListItem[]; overdueTop: TaskListItem[] };
  /** UX-3 My day: count + the top 5 of each queue. */
  replies: { count: number; top: TaskListItem[] };
  calls: { count: number; top: TaskListItem[] };
  nextSteps: { count: number; top: TaskListItem[] };
  /** Admins only (null for salespeople). */
  team: { id: string; name: string; openTasks: number; overdue: number; replies: number }[] | null;
  flags: { code: string; text: string }[] | null;
  meetings: { today: MeetingListItem[]; todayCount: number; needsOutcome: number };
  deals: {
    openCount: number;
    openAmount: number;
    stages: { stage: DealStage; count: number; amountTotal: number }[];
  };
  proposals: { awaitingDecision: number };
  /** null while the AI agent is off. */
  ai: { mode: string; draftsToReview: number } | null;
}

/** GET /proposals/:id/document: a 5-minute signed URL (fetched on click, never stored). */
export interface ProposalDocumentLink {
  url: string;
  fileName: string | null;
  expiresAt: string;
}
