// CRM v2 list/record shapes (docs/crm-v2/B4-api.md). Contacts are `leads` rows.
import type {
  AgentStatus,
  Lead,
  LeadSource,
  LifecycleState,
  NextAction,
  PipelineStage,
} from "./lead";
import type { TimelineEvent } from "./timeline";

export const DEAL_STAGES = [
  "qualified",
  "meeting_scheduled",
  "meeting_follow_up",
  "proposal_preparation",
  "proposal_sent",
  "negotiation",
  "won",
  "lost",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export type IdName = { id: string; name: string };

export interface ContactListItem {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  source: LeadSource;
  company: IdName | null;
  owner: IdName | null;
  leadStatus: PipelineStage;
  lifecycle: LifecycleState;
  openDeal: (IdName & { stage: DealStage; amount: number | null; currency: string }) | null;
  agentStatus: AgentStatus;
  nextAction: NextAction | null;
  lastActivityAt: string;
  createdAt: string;
}

export interface ContactDeal {
  id: string;
  name: string;
  stage: DealStage;
  amount: number | null;
  currency: string;
  closedAt: string | null;
}

/** GET /contacts/:id: the Lead DTO with its text `company` moved to `companyText`. */
export type ContactDetail = Omit<Lead, "company"> & {
  companyText: string;
  company: { id: string; name: string; domain: string | null } | null;
  deals: ContactDeal[];
};

/** List params exactly as the API takes them (saved views store this shape). */
export interface ContactListParams {
  ownerId?: string[] | undefined;
  leadStatus?: string[] | undefined;
  lifecycle?: string[] | undefined;
  source?: string[] | undefined;
  agentStatus?: string[] | undefined;
  companyId?: string | undefined;
  hasOpenDeal?: "true" | "false" | undefined;
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
  lastActivityFrom?: string | undefined;
  lastActivityTo?: string | undefined;
  q?: string | undefined;
  sort?: string | undefined;
}

export interface BulkResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface CompanyListItem {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  city: string | null;
  owner: IdName | null;
  contactCount: number;
  openDealCount: number;
  openDealAmount: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /companies/:id. A merged company is still returned: follow `mergedIntoCompanyId`. */
export interface CompanyDetail extends CompanyListItem {
  website: string | null;
  revenueRange: string | null;
  revenueMinCr: number | null;
  revenueMaxCr: number | null;
  state: string | null;
  country: string | null;
  linkedinUrl: string | null;
  employeeRange: string | null;
  description: string | null;
  mergedIntoCompanyId: string | null;
  createdBy: string | null;
  /** Latest activity across its (non-merged) contacts. */
  lastActivityAt: string | null;
}

/** GET /companies params exactly as the API takes them (saved views store this shape). */
export interface CompanyListParams {
  ownerId?: string[] | undefined;
  industry?: string[] | undefined;
  hasDomain?: "true" | "false" | undefined;
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
  q?: string | undefined;
  sort?: string | undefined;
  limit?: number | undefined;
}

/** POST /companies body; PATCH takes any subset ("" / null clears). */
export interface CompanyInput {
  name?: string | undefined;
  domain?: string | null | undefined;
  website?: string | null | undefined;
  industry?: string | null | undefined;
  revenueRange?: string | null | undefined;
  city?: string | null | undefined;
  state?: string | null | undefined;
  country?: string | null | undefined;
  linkedinUrl?: string | null | undefined;
  employeeRange?: string | null | undefined;
  description?: string | null | undefined;
  ownerId?: string | null | undefined;
}

export interface CompanyMergeResult {
  targetId: string;
  sourceId: string;
  movedContacts: number;
}

export interface DealListItem {
  id: string;
  name: string;
  stage: DealStage;
  amount: number | null;
  currency: string;
  expectedCloseDate: string | null;
  owner: IdName | null;
  company: IdName | null;
  contact: IdName;
  source: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DealListParams {
  status?: "open" | "won" | "lost" | "all" | undefined;
  sort?: string | undefined;
  limit?: number | undefined;
}

/** Activity chip groups; the paginated timelines filter on them server-side (`kind`). */
export const ACTIVITY_TYPES = [
  "notes",
  "calls",
  "meetings",
  "tasks",
  "messages",
  "ai",
  "deals",
  "system",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** A company feed row: whose event it is. */
export type CompanyTimelineEvent = TimelineEvent & { contact: IdName };

export type DuplicateReason =
  "similar_name" | "same_domain_different_name" | "name_domain_conflict";
export type DuplicateStatus = "open" | "merged" | "dismissed";
export interface DuplicateCompany {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  merged: boolean;
  contactCount: number;
  openDealCount: number;
}
/** A company pair (companyB set) or one contact that disagrees with its company (companyB null). */
export interface CompanyDuplicate {
  id: string;
  kind: "pair" | "contact";
  reason: DuplicateReason;
  score: number | null;
  status: DuplicateStatus;
  createdAt: string;
  resolvedAt: string | null;
  companyA: DuplicateCompany;
  companyB: DuplicateCompany | null;
  contact: { id: string; name: string; email: string | null; company: string } | null;
  observedName: string | null;
  observedDomain: string | null;
}
export interface DuplicateListParams {
  status?: Array<DuplicateStatus | "all"> | undefined;
  reason?: DuplicateReason[] | undefined;
  kind?: "pair" | "contact" | undefined;
  companyId?: string | undefined;
}

export interface DealDetail {
  id: string;
  name: string;
  stage: DealStage;
  amount: number | null;
  currency: string;
  expectedCloseDate: string | null;
  closedAt: string | null;
}

export interface CreateDealInput {
  leadId: string;
  name?: string | undefined;
  stage?: DealStage | undefined;
  amount?: number | undefined;
  currency?: "INR" | undefined;
  expectedCloseDate?: string | undefined;
}

export type SavedViewObject = "contacts" | "companies" | "deals";
export interface SavedView {
  id: string;
  object: SavedViewObject;
  name: string;
  filters: Record<string, string | string[]>;
  sort: string | null;
  columns: string[] | null;
  isShared: boolean;
  position: number;
  ownerId: string;
  isMine: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface SavedViewInput {
  object?: SavedViewObject;
  name?: string;
  filters?: Record<string, string | string[]>;
  sort?: string | null;
  columns?: string[] | null;
  isShared?: boolean;
}
