// CRM v2 list/record shapes (docs/crm-v2/B4-api.md). Contacts are `leads` rows.
import type {
  AgentStatus,
  Lead,
  LeadSource,
  LifecycleState,
  NextAction,
  PipelineStage,
} from "./lead";

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

export interface CompanyDetail extends CompanyListItem {
  website: string | null;
  mergedIntoCompanyId: string | null;
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
