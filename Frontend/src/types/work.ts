import type { IdName } from "./crm";
import type { Meeting, MeetingStatus } from "./meeting";
import type { Proposal, ProposalStatus } from "./proposal";
import type { Task, TaskType } from "./task";

/** Joined refs every work row carries (C6a). `ownerName` comes from profiles (B25/B26). */
export interface WorkRefs {
  ownerName: string | null;
  contact: IdName;
  company: IdName | null;
  /** Meetings/proposals: their deal. Tasks: the contact's most recently updated open deal. */
  deal: IdName | null;
}

export type TaskListItem = Omit<Task, "ownerName"> & WorkRefs;
export type MeetingListItem = Omit<Meeting, "ownerName"> & WorkRefs;
export type ProposalListItem = Omit<Proposal, "ownerName"> &
  WorkRefs & {
    /** What POST /proposals/:id/status accepts from the current status (backend domain). */
    allowedNextStatuses: ProposalStatus[];
  };

/** GET /tasks/list params exactly as the API takes them (saved views store this shape). */
export interface TaskListParams {
  ownerId?: string[] | undefined;
  /** Default `open`. */
  status?: "open" | "completed" | "cancelled" | "all" | undefined;
  /** IST days, decided by the backend. */
  due?: "overdue" | "today" | "upcoming" | undefined;
  dueFrom?: string | undefined;
  dueTo?: string | undefined;
  type?: TaskType[] | undefined;
  origin?: Task["origin"][] | undefined;
  contactId?: string | undefined;
  companyId?: string | undefined;
  dealId?: string | undefined;
  q?: string | undefined;
  sort?: string | undefined;
  limit?: number | undefined;
}

export interface MeetingListParams {
  ownerId?: string[] | undefined;
  status?: MeetingStatus[] | undefined;
  when?: "upcoming" | "today" | "past" | "needs_outcome" | undefined;
  from?: string | undefined;
  to?: string | undefined;
  contactId?: string | undefined;
  companyId?: string | undefined;
  dealId?: string | undefined;
  q?: string | undefined;
  sort?: string | undefined;
  limit?: number | undefined;
}

export type ProposalGroup = "open" | "awaiting_decision" | "won" | "lost";
export interface ProposalListParams {
  ownerId?: string[] | undefined;
  status?: ProposalStatus[] | undefined;
  group?: ProposalGroup | undefined;
  contactId?: string | undefined;
  companyId?: string | undefined;
  dealId?: string | undefined;
  updatedFrom?: string | undefined;
  updatedTo?: string | undefined;
  q?: string | undefined;
  sort?: string | undefined;
  limit?: number | undefined;
}

/** GET /proposals/summary: open count, sent count, open value (INR). */
export interface ProposalSummary {
  openCount: number;
  sentCount: number;
  openValue: number;
}
