// CRM v2 list/record shapes (docs/crm-v2/B4-api.md). Contacts are `leads` rows.
import type {
  AgentStatus,
  Lead,
  LeadLossReason,
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
  /** Page size (1–100); never sent to /count or stored in a saved view. */
  limit?: number | undefined;
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

export type DealStatus = "open" | "won" | "lost" | "all";

/** GET /deals params exactly as the API takes them (saved views store this shape). */
export interface DealListParams {
  stage?: DealStage[] | undefined;
  ownerId?: string[] | undefined;
  companyId?: string | undefined;
  leadId?: string | undefined;
  /** Default `open` (or `all` when `stage` is given). */
  status?: DealStatus | undefined;
  amountMin?: string | undefined;
  amountMax?: string | undefined;
  expectedCloseFrom?: string | undefined;
  expectedCloseTo?: string | undefined;
  createdFrom?: string | undefined;
  createdTo?: string | undefined;
  q?: string | undefined;
  sort?: string | undefined;
  limit?: number | undefined;
}

/** GET /deals/board: one column per stage, in pipeline order. */
export interface DealBoardColumn {
  stage: DealStage;
  count: number;
  /** INR only. */
  amountTotal: number;
  /** First 20 by updatedAt desc; more via GET /deals?stage=…&cursor=nextCursor. */
  items: DealListItem[];
  nextCursor: string | null;
}

/** Activity chip groups; the paginated timelines filter on them server-side (`kind`). */
export const ACTIVITY_TYPES = [
  "notes",
  "calls",
  "meetings",
  "proposals",
  "tasks",
  "messages",
  "ai",
  "deals",
  "system",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** A company or deal feed row: whose event it is. */
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

/** GET /deals/:id: all fields + contact, company, owner, and the meetings/proposals linked by deal_id. */
export interface DealDetail extends Omit<DealListItem, "contact"> {
  serviceInterest: string | null;
  lossReason: LeadLossReason | null;
  lossNotes: string | null;
  createdBy: string | null;
  contact: IdName & { email: string | null; phone: string | null; lifecycle: LifecycleState };
  meetings: Array<{
    id: string;
    title: string;
    at: string;
    status: string;
    outcome: string | null;
  }>;
  proposals: Array<{
    id: string;
    title: string;
    amount: number | null;
    currency: string;
    status: string;
    sentAt: string | null;
    updatedAt: string;
  }>;
}

export interface CreateDealInput {
  leadId: string;
  /** Empty = the backend's default name ("<Company> – <service interest>"). */
  name?: string | undefined;
  stage?: DealStage | undefined;
  amount?: number | undefined;
  currency?: "INR" | undefined;
  expectedCloseDate?: string | undefined;
  /** Omitted = the contact's owner; null = no owner. */
  ownerId?: string | null | undefined;
}

/** PATCH /deals/:id (stage moves go through POST /deals/:id/stage). */
export interface UpdateDealInput {
  name?: string | undefined;
  amount?: number | null | undefined;
  expectedCloseDate?: string | null | undefined;
  ownerId?: string | null | undefined;
  companyId?: string | null | undefined;
}

/** What closing a deal as lost does to its contact (only with stage `lost`). */
export type ContactAction = "keep" | "long_term_nurture" | "lost";

export interface MoveDealStageInput {
  stage: DealStage;
  lossReason?: LeadLossReason | undefined;
  lossNotes?: string | undefined;
  contactAction?: ContactAction | undefined;
}

export type SavedViewObject =
  "contacts" | "companies" | "deals" | "tasks" | "meetings" | "proposals";
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
  position?: number;
}
