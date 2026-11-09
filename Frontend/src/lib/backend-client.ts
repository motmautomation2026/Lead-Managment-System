import { backendBaseUrl, configurationError, supabase } from "./supabase-client";
import type { SearchResults } from "@/types/search";
import type {
  AgentStatus,
  BulkResult,
  ActivityType,
  CompanyDetail,
  CompanyDuplicate,
  CompanyInput,
  CompanyListItem,
  CompanyListParams,
  CompanyMergeResult,
  CompanyTimelineEvent,
  DealListItem,
  DealListParams,
  DuplicateListParams,
  ContactDetail,
  ContactListItem,
  ContactListParams,
  CreateDealInput,
  DealBoardColumn,
  DealDetail,
  DealStage,
  MoveDealStageInput,
  UpdateDealInput,
  SavedView,
  SavedViewInput,
  SavedViewObject,
  AppNotification,
  AutomationMode,
  Call,
  CallConnectedOutcome,
  CallNotConnectedReason,
  Contactability,
  Lead,
  LeadLossReason,
  LeadNote,
  LeadSource,
  LifecycleState,
  Meeting,
  MeetingListItem,
  MeetingListParams,
  MeetingOutcome,
  MeetingStatus,
  PipelineStage,
  Proposal,
  ProposalListItem,
  ProposalListParams,
  ProposalStatus,
  ProposalSummary,
  HomeSummary,
  ProposalDocumentLink,
  RunListItem,
  RunListParams,
  ScheduledActionListItem,
  ScheduledActionListParams,
  ResponseState,
  Run,
  ScheduledAction,
  Task,
  TaskListItem,
  TaskListParams,
  TaskType,
  Template,
  TemplateAttachment,
  TimelineEvent,
  InboundReply,
  ReplyLabel,
  ReplyChannel,
  ReplyDraft,
  User,
  Workflow,
  WorkflowStep,
  WorkflowTrigger,
} from "@/types";

export class BackendError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

// The currently-selected workspace, set by WorkspaceProvider (see
// store/workspace-context.tsx) whenever the user's selection changes.
// Attached as X-Workspace-Id on every CRM request below — every route
// except /me, /profiles, and /workspaces itself requires it server-side.
let currentWorkspaceId: string | null = null;
export function setCurrentWorkspaceId(id: string | null) {
  currentWorkspaceId = id;
}
export function getCurrentWorkspaceId() {
  return currentWorkspaceId;
}
function workspaceHeaders(): Record<string, string> {
  return currentWorkspaceId ? { "X-Workspace-Id": currentWorkspaceId } : {};
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (configurationError || !backendBaseUrl || !supabase)
    throw new BackendError(
      0,
      "configuration_error",
      configurationError ?? "Frontend is not configured.",
    );
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token)
    throw new BackendError(401, "authentication_failed", "Authentication is required.");
  let response: Response;
  try {
    response = await fetch(`${backendBaseUrl}/api/v1${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.session.access_token}`,
        ...workspaceHeaders(),
        ...init.headers,
      },
    });
  } catch (error) {
    throw new BackendError(
      0,
      "network_error",
      error instanceof Error ? error.message : "Backend request failed.",
    );
  }
  const body = (await response.json().catch(() => undefined)) as
    { error?: { code?: string; message?: string; details?: unknown } } | undefined;
  if (!response.ok) {
    if (response.status === 401) void supabase.auth.signOut({ scope: "local" });
    throw new BackendError(
      response.status,
      body?.error?.code ?? "unknown",
      body?.error?.message ?? response.statusText,
      body?.error?.details,
    );
  }
  return body as T;
}

function query(path: string, params?: Record<string, string | number | boolean | undefined>) {
  if (!params) return path;
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) search.set(key, String(value));
  });
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}
/** B4 list params: arrays repeat the key (`ownerId=a&ownerId=b`), empty values are dropped. */
export function listQuery(
  path: string,
  params: Record<string, string | string[] | number | undefined>,
) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === "") return;
    (Array.isArray(value) ? value : [value]).forEach((v) => search.append(key, String(v)));
  });
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}
type Page<T> = { data: T[]; nextCursor: string | null };
const get = <T>(path: string, signal?: AbortSignal) => request<T>(path, signal ? { signal } : {});
const send = <T>(method: "POST" | "PATCH" | "PUT", path: string, body?: unknown) =>
  request<T>(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const del = (path: string) => request<void>(path, { method: "DELETE" });

/** Like `request`, but for a multipart/form-data body — omits the JSON Content-Type header so the browser sets the multipart boundary itself. */
async function uploadFile<T>(path: string, formData: FormData): Promise<T> {
  if (configurationError || !backendBaseUrl || !supabase)
    throw new BackendError(
      0,
      "configuration_error",
      configurationError ?? "Frontend is not configured.",
    );
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token)
    throw new BackendError(401, "authentication_failed", "Authentication is required.");
  let response: Response;
  try {
    response = await fetch(`${backendBaseUrl}/api/v1${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${data.session.access_token}`, ...workspaceHeaders() },
      body: formData,
    });
  } catch (error) {
    throw new BackendError(
      0,
      "network_error",
      error instanceof Error ? error.message : "Backend request failed.",
    );
  }
  const body = (await response.json().catch(() => undefined)) as
    { error?: { code?: string; message?: string; details?: unknown } } | undefined;
  if (!response.ok) {
    if (response.status === 401) void supabase.auth.signOut({ scope: "local" });
    throw new BackendError(
      response.status,
      body?.error?.code ?? "unknown",
      body?.error?.message ?? response.statusText,
      body?.error?.details,
    );
  }
  return body as T;
}

export interface CreateLeadInput {
  firstName: string;
  lastName?: string | undefined;
  company: string;
  jobTitle?: string | undefined;
  industry?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  source: LeadSource;
  serviceInterest?: string | undefined;
  revenueRange?: string | undefined;
  /** Omit to let the workspace's revenue rules pick the owner. */
  ownerId?: string | undefined;
}
export interface ImportLeadRow {
  rowNumber: number;
  firstName: string;
  lastName?: string | undefined;
  company: string;
  jobTitle?: string | undefined;
  industry?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  source: string;
  serviceInterest?: string | undefined;
  revenueRange?: string | undefined;
}
export interface ImportLeadsResult {
  created: Lead[];
  duplicates: { rowNumber: number; reason: string }[];
  failed: { rowNumber: number; reason: string }[];
  totalRows: number;
}
export interface UpdateLeadInput {
  firstName?: string | undefined;
  lastName?: string | undefined;
  company?: string | undefined;
  jobTitle?: string | undefined;
  industry?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  source?: LeadSource | undefined;
  serviceInterest?: string | undefined;
  revenueRange?: string | undefined;
  ownerId?: string | undefined;
  pipelineStage?: PipelineStage | undefined;
  responseState?: ResponseState | undefined;
}
export interface LeadFilters {
  stage?: PipelineStage;
  lifecycle?: LifecycleState;
  ownerId?: string;
  source?: LeadSource;
  automationMode?: AutomationMode;
  search?: string;
  limit?: number;
  offset?: number;
}
export interface LogCallInput {
  connected: boolean;
  notConnectedReason?: CallNotConnectedReason | undefined;
  connectedOutcome?: CallConnectedOutcome | undefined;
  notes?: string | undefined;
  callbackDueAt?: string | undefined;
  taskId?: string | undefined;
  /** "Interested - Later" capture — read by the backend only when connectedOutcome === 'interested_later'. */
  interestedLater?:
    | {
        reason?: string | undefined;
        restartAt?: string | undefined;
        nextAction?: string | undefined;
        decisionOwner?: string | undefined;
      }
    | undefined;
}
export interface CreateTaskInput {
  leadId: string;
  ownerId?: string | undefined;
  type: TaskType;
  title: string;
  dueAt: string;
}
export interface UpdateTaskInput {
  ownerId?: string | undefined;
  type?: TaskType | undefined;
  title?: string | undefined;
  dueAt?: string | undefined;
}
export interface CreateMeetingInput {
  leadId: string;
  ownerId?: string | undefined;
  title: string;
  at: string;
  durationMin?: number | undefined;
  url?: string | undefined;
  participants?: { name?: string | undefined; email: string }[] | undefined;
  /** Attach to this deal (else the contact's newest open deal, else a new one). */
  dealId?: string | undefined;
}
export interface UpdateMeetingInput {
  title?: string | undefined;
  at?: string | undefined;
  durationMin?: number | undefined;
  url?: string | undefined;
  status?: MeetingStatus | undefined;
  notes?: string | undefined;
}
export interface CreateProposalInput {
  leadId: string;
  title: string;
  amount?: number | undefined;
  notes?: string | undefined;
  emailTemplateId: string;
  whatsappTemplateId: string;
  document: File;
  /** Attach to this deal (else the contact's newest open deal, else a new one). */
  dealId?: string | undefined;
}
export interface UpdateProposalInput {
  title?: string | undefined;
  fileName?: string | undefined;
  amount?: number | undefined;
  notes?: string | undefined;
}
export interface CreateWorkflowInput {
  name: string;
  description?: string | undefined;
  trigger: WorkflowTrigger;
  ownerId?: string | undefined;
}
export interface UpdateWorkflowInput {
  name?: string | undefined;
  description?: string | undefined;
  trigger?: WorkflowTrigger | undefined;
  status?: "active" | "paused" | undefined;
  ownerId?: string | undefined;
}
export interface CreateTemplateInput {
  name: string;
  channel: "email" | "whatsapp";
  subject?: string | undefined;
  body: string;
}
export interface UpdateTemplateInput {
  name?: string | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  active?: boolean | undefined;
  isDefaultMeetingScheduled?: boolean | undefined;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  initials: string;
  active: boolean;
  createdAt: string;
  /** E3b-1: the salesperson's booking page; null = none. */
  bookingUrl: string | null;
}

export type WorkspaceRole = "admin" | "salesperson";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** E4b: the user's role in this workspace (a super-admin: admin everywhere). */
  role: WorkspaceRole;
}

/** E4b: Settings → Team. */
export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  active: boolean;
  role: WorkspaceRole;
  since: string;
}

/** E4b: the super-admin page (every workspace × active users). */
export interface MembershipPage {
  workspaces: { id: string; name: string }[];
  data: {
    id: string;
    name: string;
    email: string;
    isSuperAdmin: boolean;
    roles: Record<string, WorkspaceRole>;
  }[];
  nextCursor: string | null;
}

export type KnowledgeStatus = "pending" | "processing" | "ready" | "failed";
export interface KnowledgeDocument {
  id: string;
  title: string;
  docType: string;
  tags: string[];
  source: "upload" | "text";
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  status: KnowledgeStatus;
  error: string | null;
  chunkCount: number;
  attemptCount: number;
  isActive: boolean;
  /** Set when this is an asset's searchable copy: manage it through the asset. */
  assetId: string | null;
  processedAt: string | null;
  nextAttemptAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface KnowledgeDocumentDetail extends KnowledgeDocument {
  extractedTextPreview: string | null;
  extractedTextLength: number;
}
export interface KnowledgeAsset {
  id: string;
  title: string;
  useWhen: string;
  tags: string[];
  channels: ("email" | "whatsapp")[];
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  isActive: boolean;
  kbDocumentId: string | null;
  status: KnowledgeStatus | null;
  error: string | null;
  chunkCount: number;
  /** Signed for 5 minutes. */
  downloadUrl: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  docType: string;
  content: string;
  metadata: { page?: number; slide?: number; heading?: string };
  score: number;
}

/** One revenue rule: minCr exclusive, maxCr inclusive, both in crore; null = open. */
export interface AssignmentRuleInput {
  position: number;
  minCr: number | null;
  maxCr: number | null;
  ownerId: string;
}
export interface AssignmentRules {
  rules: (AssignmentRuleInput & { id: string; ownerName: string; ownerActive: boolean })[];
  fallbackOwnerId: string | null;
  fallbackOwnerName: string | null;
  /** False when the saved fallback owner has been deactivated (new leads then stay unassigned). */
  fallbackOwnerAvailable: boolean;
}

export type AgentMode = "off" | "shadow" | "live";
/** E2: which AI contacts are live in a live workspace. */
export type AgentLiveScope = "test_contacts" | "new_leads" | "all";
/** E2: a live send decision's real send; null = a draft / not a send. */
export type AgentSendStatus = "queued" | "sending" | "sent" | "failed" | "cancelled" | "dry_run";
export interface AgentSendState {
  sendStatus: AgentSendStatus | null;
  sentAt: string | null;
  sendError: string | null;
  cancelReason: string | null;
  channel: "email" | "whatsapp" | null;
  /** E3b-1: the stage plan the decision was made under (null before E3b-1); the angle only for a message. */
  stageKey?: string | null;
  angle?: string | null;
  /** E3b-2b: the AI email's first counted open (soft signal), else null. */
  openedAt?: string | null;
}
export interface AgentReadiness {
  ready: boolean;
  rated: number;
  goodPct: number | null;
  seriousBad: number;
  reasons: string[];
}
/** GET /agent/settings/live-preview (admin): what switching to Live with a scope would do. */
export interface AgentLivePreview {
  scope: AgentLiveScope;
  readiness: AgentReadiness;
  allowed: boolean;
  message: string | null;
  liveContacts: number;
  workflowRunsToCancel: number;
}
/** GET/PUT /agent/settings (admin only). Times are "HH:MM" in IST; send days are ISO weekdays (Mon=1). */
export interface AgentSettings {
  mode: AgentMode;
  sendDays: number[];
  sendWindowStart: string;
  sendWindowEnd: string;
  minGapHours: number;
  maxTouches7d: number;
  maxTouchesTotal: number;
  emailMaxWords: number;
  whatsappMaxWords: number;
  /** E2b: phrases an AI message must never contain. */
  bannedPhrases: string[];
  /** E3a: admin-written examples of the style; empty = none. */
  styleExamples: string;
  /** E3b-2b: the workspace's buyer industries for the hot-lead score (lower case). */
  targetIndustryKeywords: string[];
  /** E3b-1: the channel of a contact's first AI message when both work; then channels alternate. */
  firstChannel: "whatsapp" | "email";
  wakeMinDays: number;
  wakeMaxDays: number;
  nurtureLongTerm: boolean;
  monthlyBudgetUsd: number;
  maxDecisionsPerDay: number;
  /** null = the server's default model. */
  decisionModel: string | null;
  groundingModel: string | null;
  emailOptOutText: string;
  whatsappOptOutText: string;
  repQuietHours: number;
  autoEnrollNewLeads: boolean;
  /** The selling company name in AI messages; null = the workspace name. */
  companyDisplayName: string | null;
  liveScope: AgentLiveScope;
  /** When the new-leads pilot was switched on. */
  liveSince: string | null;
  /** E2f, read-only: the go-live gate counts decisions created since this time; null = all time. */
  readinessSince: string | null;
  /** Read-only: AI contacts live now. */
  liveContactCount: number;
  currentPlaybookVersion: number | null;
  updatedBy: string | null;
  updatedAt: string;
  /** Read-only: leads enrolled in the AI (agent_status active). */
  activeLeadCount: number;
}
export type AgentSettingsUpdate = Partial<
  Omit<
    AgentSettings,
    | "currentPlaybookVersion"
    | "updatedBy"
    | "updatedAt"
    | "activeLeadCount"
    | "liveSince"
    | "readinessSince"
    | "liveContactCount"
  >
>;
export interface AgentPlaybook {
  id: string;
  version: number;
  body: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

// --- AI decision review (3D) -------------------------------------------------------
export type AgentAction =
  "send_email" | "send_whatsapp" | "wait" | "handoff" | "update_stage" | "stop";
export type AgentOutcome = "draft" | "sent" | "skipped" | "blocked" | "executed" | "failed";
export type AgentRatingReason =
  "made_up_fact" | "internal_info_leak" | "wrong_tone" | "wrong_timing" | "wrong_action" | "other";
export interface AgentDecisionFilters {
  action?: AgentAction | undefined;
  outcome?: AgentOutcome | undefined;
  rating?: "good" | "bad" | "unrated" | undefined;
  hasOpenReport?: boolean | undefined;
  leadId?: string | undefined;
  /** ISO datetimes. */
  from?: string | undefined;
  to?: string | undefined;
}
export interface AgentDecisionRow extends AgentSendState {
  id: string;
  createdAt: string;
  mode: "shadow" | "live";
  lead: { id: string; name: string; company: string };
  ownerName: string | null;
  action: AgentAction;
  outcome: AgentOutcome;
  /** Email subject, handoff title, new stage or stop reason. */
  subject: string | null;
  bodyPreview: string | null;
  regenerated: boolean;
  rating: "good" | "bad" | null;
  ratingReason: AgentRatingReason | null;
  openReports: number;
}
export interface AgentRuleNote {
  rule: string;
  message: string;
}
export interface AgentDecisionReport {
  id: string;
  decisionId: string;
  reportedBy: string | null;
  reportedByName: string | null;
  note: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByName?: string | null;
  resolutionNote: string | null;
}
export type AgentComposedMessage =
  | { channel: "email"; subject: string; text: string; html: string; bookingLinkAdded?: boolean }
  | { channel: "whatsapp"; text: string; bookingLinkAdded?: boolean };
/** The company and open deal the decision saw (D1); null on decisions from before D1 or without one. */
export interface AgentDecisionContext {
  company: { id: string; name: string } | null;
  deal: { id: string; name: string; stage: DealStage | null } | null;
}
export type AttachmentRemovalReason =
  "first_message" | "whatsapp_no_reply" | "already_sent" | "count_limit" | "size_limit";
/**
 * E2g: a send decision's attachments by title (`sent` = really went out), the ones the rules
 * removed, and the ones left out at send time; null for non-send actions.
 */
export interface AgentDecisionAttachments {
  assets: { id: string; title: string | null; sent: boolean }[];
  removed: { assetId: string; reason: AttachmentRemovalReason; title: string | null }[];
  issues: { assetId: string; title: string | null; reason: string }[];
}
export interface AgentAutoFix {
  rule: string;
  before: string;
  after: string;
}
export interface AgentDecisionDetail extends AgentSendState {
  id: string;
  createdAt: string;
  mode: "shadow" | "live";
  action: AgentAction;
  outcome: AgentOutcome;
  error: string | null;
  reasoning: string | null;
  messageSubject: string | null;
  messageBody: string | null;
  sendAt: string | null;
  nextWakeAt: string | null;
  handoffTitle: string | null;
  handoffUrgency: "low" | "normal" | "high" | null;
  newStage: string | null;
  stopReason: string | null;
  rulesResult: {
    allowed: boolean;
    violations: AgentRuleNote[];
    adjustments: AgentRuleNote[];
  } | null;
  groundingResult: {
    supported: boolean;
    unsupportedClaims: string[];
    ignoredClaims?: string[];
    /** E2b: playbook style problems from the grounding call (absent before E2b). */
    styleViolations?: { rule: string; quote: string }[] | null;
  } | null;
  regenerated: boolean;
  /** E2b: what each drafting attempt failed (empty = passed); null before E2b. */
  qualityChecks:
    | {
        problems: string[];
        /** E2g: attachments the rules removed on this attempt. */
        attachmentsRemoved?: AgentDecisionAttachments["removed"];
        /** E3a: what code fixed on this attempt's text. */
        autoFixes?: AgentAutoFix[];
        /** E3a: this attempt's input tokens and the part served from the prompt cache. */
        inputTokens?: number;
        cachedInputTokens?: number;
      }[]
    | null;
  playbookVersion: number | null;
  decisionModel: string | null;
  groundingModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  rating: "good" | "bad" | null;
  ratingReason: AgentRatingReason | null;
  ratingNote: string | null;
  ratedBy: string | null;
  ratedByName: string | null;
  ratedAt: string | null;
  leadId: string;
  lead: { id: string; name: string; company: string; ownerId: string | null };
  context: AgentDecisionContext;
  attachments: AgentDecisionAttachments | null;
  /** The message exactly as it would go out; null for non-send actions. */
  composed: AgentComposedMessage | null;
  chunks: { id: string; deleted: boolean; title: string; text: string }[];
  reports: AgentDecisionReport[];
}
export interface AgentRatingInput {
  rating: "good" | "bad";
  reason?: AgentRatingReason | undefined;
  note?: string | undefined;
}
export interface AgentStats {
  mode: AgentMode | null;
  byAction: Partial<Record<AgentAction, number>>;
  byOutcome: Partial<Record<AgentOutcome, number>>;
  failed: number;
  ratings: {
    rated: number;
    good: number;
    bad: number;
    badByReason: Record<AgentRatingReason, number>;
  };
  openReports: number;
  spend: { month: string; spentUsd: number; budgetUsd: number | null };
  /** D4a: WhatsApp replies labelled this month (counts only) and the AI cost of labelling them. */
  replies: { byLabel: Partial<Record<ReplyLabel, number>>; costUsd: number };
  readiness: AgentReadiness;
  /** E2f: ratings and readiness count decisions created since this time; null = all time. */
  readinessSince: string | null;
  /** E2: the live scope and real AI sends. */
  live: {
    scope: AgentLiveScope;
    liveSince: string | null;
    liveContacts: number;
    sentToday: number;
    sentThisMonth: number;
  } | null;
  /** E2b: the writing rules, readable by every CRM user. */
  messageRules: AgentMessageRules | null;
  /** E3a: how the writer does against the checks, since the go-live count started and over 7 days. */
  quality: { sinceReadiness: AgentQualityStats; last7Days: AgentQualityStats };
}
export interface AgentQualityStats {
  /** Decisions that wrote a message (sent on, or turned into a handoff by the checks). */
  sendDecisions: number;
  passedFirstTry: number;
  /** null = no message written yet. */
  passedFirstTryPct: number | null;
  regenerated: number;
  checkHandoffs: number;
  checkHandoffsByReason: Record<string, number>;
  autoFixes: number;
  avgCostUsd: number | null;
  /** Share of input tokens served from the prompt cache; null = none recorded. */
  cachedInputPct: number | null;
}
export type AgentMessageRules = Pick<
  AgentSettings,
  "bannedPhrases" | "emailMaxWords" | "whatsappMaxWords" | "styleExamples"
>;
export interface LeadAgentPanel {
  leadId: string;
  status: AgentStatus;
  statusReason: string | null;
  statusChangedAt: string | null;
  touchCount: number;
  lastTouchAt: string | null;
  /** E2: an admin marked this contact as an AI live test contact. */
  liveTest: boolean;
  /** E2: how the AI runs for this contact now. */
  effectiveMode: AgentMode;
  nextWakeup: { id: string; dueAt: string; reason: string } | null;
  decisions: (Pick<
    AgentDecisionDetail,
    | "id"
    | "createdAt"
    | "mode"
    | "action"
    | "outcome"
    | "reasoning"
    | "messageSubject"
    | "messageBody"
    | "sendAt"
    | "handoffTitle"
    | "newStage"
    | "stopReason"
    | "regenerated"
    | "error"
    | "rating"
    | "ratingReason"
    | "ratingNote"
    | "context"
    | "attachments"
    | keyof AgentSendState
  > & {
    rules: AgentDecisionDetail["rulesResult"];
    grounding: AgentDecisionDetail["groundingResult"];
    openReports: number;
  })[];
}
export type AgentEnrollSkipReason =
  "not_found" | "not_eligible" | "already_active" | "permanently_stopped" | "no_contact";
export type AgentEnrollResult =
  | { leadId: string; result: "enrolled" }
  | { leadId: string; result: "skipped"; reason: AgentEnrollSkipReason }
  | { leadId: string; result: "failed"; message: string };

export type MailSecurity = "ssl" | "starttls";

/** E1b: GET /connections/email/settings (every CRM user; never any secret). */
export interface EmailImapStatus {
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  /** Plain English, never a secret. */
  lastError: string | null;
  nextCheckAt: string | null;
  /** Messages read today (IST). */
  today: {
    replies: number;
    bounces: number;
    autoReplies: number;
    unsubscribes: number;
    unmatched: number;
  };
  bounces24h: number;
}

export interface EmailSettings {
  /** SMTP saved (the only provider); false = "Email is not set up". */
  configured: boolean;
  /** "resend" = saved before E1b, no longer supported. */
  legacyProvider: "resend" | null;
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailSecurity;
  smtpUsernameConfigured: boolean;
  smtpPasswordConfigured: boolean;
  fromAddress: string;
  fromName: string;
  replyTo: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: MailSecurity;
  imapSameLogin: boolean;
  imapUsernameConfigured: boolean;
  imapPasswordConfigured: boolean;
  imapFolder: string;
  dailyCap: number;
  hourlyCap: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  sendWindow: WhatsAppSendWindow;
  alreadyWarmed: boolean;
  configuredAt: string | null;
  warmupDay: number | null;
  effectiveDailyCap: number;
  sentToday: number;
  sentThisHour: number;
  pause: { reason: string | null; at: string | null; byName: string | null } | null;
  failures24h: number;
  rejections24h: number;
  queuedCount: number;
  safetyEvents: {
    kind:
      | "send_failed"
      | "recipient_rejected"
      | "login_rejected"
      | "rate_limited"
      | "paused"
      | "resumed";
    detail: string | null;
    at: string;
  }[];
  daily: { date: string; sent: number; failed: number; rejected: number }[];
  /** D3: reading replies, bounces and unsubscribes over IMAP; null until an IMAP login is saved. */
  imapStatus: EmailImapStatus | null;
  /** E3b-2b: "Track email opens" (default off) and whether the API has a public address for the pixel. */
  trackOpens: boolean;
  openTrackingAvailable: boolean;
  updatedAt: string;
}

/** E3b-2b GET /analytics/funnel. */
export type FunnelGroupBy = "source" | "channel" | "number" | "angle";
export interface FunnelParams {
  from?: string | undefined;
  to?: string | undefined;
  groupBy?: FunnelGroupBy | undefined;
}
export interface FunnelLeadMetrics {
  leadsCreated: number;
  contacted: number;
  firstMessageWithin15Min: { count: number; pct: number | null };
  medianMinutesToFirstMessage: number | null;
  emailsSent: number;
  countedOpens: number;
  replies: number;
  positiveReplies: number;
  meetingsBookedWithin14Days: number;
  proposals: number;
  won: number;
}
export interface FunnelMessageMetrics {
  messagesSent: number;
  emailsSent: number;
  countedOpens: number;
  replies: number;
  positiveReplies: number;
  meetingsBooked: number;
  dealsCreated: number;
  won: number;
}
export interface Funnel {
  from: string;
  to: string;
  groupBy: FunnelGroupBy | null;
  totals: FunnelLeadMetrics;
  websiteMeetingRate: { websiteLeads: number; bookedWithin14Days: number; pct: number | null };
  medianMinutesReplyToAnswer: number | null;
  groups: ({ key: string | null; label: string | null } & (Partial<FunnelLeadMetrics> &
    Partial<FunnelMessageMetrics>))[];
}

/** PUT /connections/email/settings (admin). Blank secrets keep the saved ones. */
export interface EmailSettingsInput {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailSecurity;
  smtpUsername?: string;
  smtpPassword?: string;
  fromAddress: string;
  fromName: string;
  replyTo: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: MailSecurity;
  imapSameLogin: boolean;
  imapUsername?: string;
  imapPassword?: string;
  imapFolder: string;
  dailyCap: number;
  hourlyCap: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  sendWindow: WhatsAppSendWindow;
  alreadyWarmed: boolean;
}

export interface EmailConnectionTest {
  ok: boolean;
  message: string;
}

export interface TestEmailStatus {
  id: string;
  status: "queued" | "sending" | "sent" | "failed" | "cancelled";
  to?: string;
  lastError?: string | null;
  sentAt?: string | null;
  dryRun?: boolean;
}

export interface DeliverabilityCheck {
  domain: string;
  checkedAt: string;
  lines: {
    check: "mx" | "spf" | "dkim" | "dmarc";
    status: "green" | "amber" | "red";
    summary: string;
    fix: string | null;
  }[];
}

export interface WhatsAppSendWindow {
  /** ISO weekdays, 1 = Monday. */
  days: number[];
  start: string;
  end: string;
}

/** Workspace-level WhatsApp settings (E4a): master switch for all numbers, send window, max numbers. */
export interface WhatsAppSettingsInput {
  enabled: boolean;
  maxNumbers: number;
  sendWindow: WhatsAppSendWindow;
}

/** One number's admin settings (E4a). */
export interface WhatsAppNumberInput {
  label?: string;
  ownerUserId?: string | null;
  dailyCap?: number;
  minDelaySeconds?: number;
  maxDelaySeconds?: number;
  maxNewChatsPerDay?: number;
}

/** E4a: one WhatsApp number of the workspace (own pairing, warm-up, caps, spacing and pause). */
export interface WhatsAppNumber {
  id: string;
  label: string;
  ownerUserId: string | null;
  ownerName: string | null;
  enabled: boolean;
  desiredState: string;
  status: string;
  connectedPhone: string | null;
  displayName: string | null;
  qr: string | null;
  qrExpiresAt: string | null;
  lastError: string | null;
  workerHeartbeatAt: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  outboundRestricted: boolean;
  pairedAt: string | null;
  /** Day since pairing (1 = pairing day, IST); null = paired before E1, fully warmed up. */
  warmupDay: number | null;
  dailyCap: number;
  effectiveDailyCap: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  maxNewChatsPerDay: number;
  sentToday: number;
  newChatsToday: number;
  /** Contacts whose sticky number this is. */
  leadCount: number;
  /** Prepared (claimed, not yet sent) messages on this number. */
  queuedSends: number;
  /** Set while this number's outbound is off (`enabled` false). */
  pause: { reason: string | null; at: string | null; byName: string | null } | null;
}

export interface WhatsAppConnection {
  /** The workspace master switch for every number. */
  enabled: boolean;
  maxNumbers: number;
  sendWindow: WhatsAppSendWindow;
  numbers: WhatsAppNumber[];
  /** Rule 12: numbers holding a session-pooler slot, across all workspaces, vs the headroom. */
  sessionSlots: { numbers: number; headroom: number; overHeadroom: boolean };
  todayCount: number;
  pendingCount: number;
  invalidPhoneCount: number;
  newChatsToday: number;
  failures24h: number;
  stops24h: number;
  safetyEvents: {
    kind: "send_failed" | "reconnect_failed" | "disconnected" | "restricted" | "paused" | "resumed";
    detail: string | null;
    at: string;
    numberLabel: string | null;
  }[];
  /** Last 14 IST days, newest first. */
  daily: { date: string; sent: number; failed: number; stops: number }[];
  inboundReview: {
    messageId: string;
    senderPhoneE164: string | null;
    messageType: string;
    receivedAt: string;
    matchCount: number;
    disposition: "unmatched" | "ambiguous";
  }[];
}

export type RemoveWhatsAppNumberInput = { leads?: "move" | "unassign"; moveToNumberId?: string };

export interface GoogleCalendarConnection {
  configured: boolean;
  /** The server has a shared Google app, so users can connect with one click. */
  platformConfigured: boolean;
  /** This workspace saved its own OAuth client (the "advanced" override). */
  usesOwnCredentials: boolean;
  enabled: boolean;
  status: "disconnected" | "connected" | "error";
  clientId: string | null;
  redirectUri: string | null;
  clientSecretConfigured: boolean;
  connectedEmail: string | null;
  connectedCalendarId: string;
  lastError: string | null;
  lastSyncedAt: string | null;
  updatedAt: string;
}

export const backend = {
  /** Global search (B4): q trimmed, ≥ 2 characters. */
  search: (q: string, signal?: AbortSignal) => get<SearchResults>(query("/search", { q }), signal),
  /** CRM v2 contacts (B4 §2). Writes stay on `leads`. */
  contacts: {
    list: (params: ContactListParams, cursor?: string, signal?: AbortSignal) =>
      get<Page<ContactListItem>>(listQuery("/contacts", { ...params, cursor }), signal),
    count: (params: Omit<ContactListParams, "sort">, signal?: AbortSignal) =>
      get<{ count: number }>(listQuery("/contacts/count", params), signal),
    get: (id: string, signal?: AbortSignal) => get<ContactDetail>(`/contacts/${id}`, signal),
    /** E4a rule 6 — admin only: move the contact to another WhatsApp number (reason required). */
    changeWhatsAppNumber: (id: string, input: { numberId: string; reason: string }) =>
      send<{ whatsappNumber: { id: string; label: string } }>(
        "POST",
        `/contacts/${id}/whatsapp-number`,
        input,
      ),
    /** At most 100 ids; `enrollAi` is admin only. */
    bulk: (input: { ids: string[]; action: "assignOwner" | "enrollAi"; ownerId?: string }) =>
      send<{ data: BulkResult[] }>("POST", "/contacts/bulk", input),
    /** Paginated, newest first (C3). The old `leads.timeline` returns everything. */
    timeline: (id: string, kind: ActivityType[], cursor?: string, signal?: AbortSignal) =>
      get<Page<TimelineEvent>>(listQuery(`/contacts/${id}/timeline`, { kind, cursor }), signal),
    /** D2: one reply's text (owner + admins; audited server-side). Only after a click. D3: email too. */
    reply: async (
      id: string,
      messageId: string,
      signal?: AbortSignal,
      channel: ReplyChannel = "whatsapp",
    ) => {
      if (channel === "whatsapp") {
        return get<InboundReply>(
          `/contacts/${id}/replies/${encodeURIComponent(messageId)}`,
          signal,
        );
      }
      const { replyId, ...rest } = await get<Omit<InboundReply, "messageId"> & { replyId: string }>(
        `/contacts/${id}/email-replies/${encodeURIComponent(messageId)}`,
        signal,
      );
      return { ...rest, messageId: replyId } satisfies InboundReply;
    },
    /** E3b-2a: the contact's open (else latest sent) suggested reply; owner + admins. */
    latestReplyDraft: (id: string, signal?: AbortSignal) =>
      get<{ draft: ReplyDraft | null }>(`/contacts/${id}/reply-drafts/latest`, signal),
    /** E3b-2a: queue the (edited) suggested reply; the worker sends it in the send window. */
    sendReplyDraft: (id: string, draftId: string, body: string) =>
      send<ReplyDraft>("POST", `/contacts/${id}/reply-drafts/${draftId}/send`, { body }),
    discardReplyDraft: (id: string, draftId: string) =>
      send<ReplyDraft>("POST", `/contacts/${id}/reply-drafts/${draftId}/discard`),
    /** D4a: the owner or an admin changes a reply's label (never "unclassified"). */
    setReplyLabel: (
      id: string,
      messageId: string,
      label: Exclude<ReplyLabel, "unclassified">,
      channel: ReplyChannel = "whatsapp",
    ) =>
      send<{ messageId: string; label: ReplyLabel; labelSource: "rep"; labelBy: string }>(
        "PUT",
        `/contacts/${id}/${channel === "email" ? "email-replies" : "replies"}/${encodeURIComponent(messageId)}/label`,
        { label },
      ),
  },
  /** CRM v2 companies (B4 §3). Merge is admin only. */
  companies: {
    list: (params: CompanyListParams, cursor?: string, signal?: AbortSignal) =>
      get<Page<CompanyListItem>>(listQuery("/companies", { ...params, cursor }), signal),
    count: (params: Omit<CompanyListParams, "sort" | "limit">, signal?: AbortSignal) =>
      get<{ count: number }>(listQuery("/companies/count", params), signal),
    get: (id: string, signal?: AbortSignal) => get<CompanyDetail>(`/companies/${id}`, signal),
    /** Distinct industries of live companies (the Industry filter's options). */
    industries: (signal?: AbortSignal) => get<{ data: string[] }>("/companies/industries", signal),
    /** 409 with `details.companyId` when the normalised name or domain already exists. */
    create: (input: CompanyInput & { name: string }) =>
      send<CompanyDetail>("POST", "/companies", input),
    update: (id: string, input: CompanyInput) =>
      send<CompanyDetail>("PATCH", `/companies/${id}`, input),
    /** `id` is kept; `sourceId` is merged into it. */
    merge: (id: string, sourceId: string) =>
      send<CompanyMergeResult>("POST", `/companies/${id}/merge`, { sourceId }),
    contacts: (id: string, params: ContactListParams, cursor?: string, signal?: AbortSignal) =>
      get<Page<ContactListItem>>(
        listQuery(`/companies/${id}/contacts`, { ...params, cursor }),
        signal,
      ),
    deals: (id: string, params: DealListParams, cursor?: string, signal?: AbortSignal) =>
      get<Page<DealListItem>>(listQuery(`/companies/${id}/deals`, { ...params, cursor }), signal),
    timeline: (id: string, kind: ActivityType[], cursor?: string, signal?: AbortSignal) =>
      get<Page<CompanyTimelineEvent>>(
        listQuery(`/companies/${id}/timeline`, { kind, cursor }),
        signal,
      ),
  },
  /** Admin duplicate review (B4 §5). */
  companyDuplicates: {
    list: (params: DuplicateListParams, cursor?: string, signal?: AbortSignal) =>
      get<Page<CompanyDuplicate>>(listQuery("/company-duplicates", { ...params, cursor }), signal),
    count: (params: DuplicateListParams, signal?: AbortSignal) =>
      get<{ count: number }>(listQuery("/company-duplicates/count", { ...params }), signal),
    /** Pair rows: `targetId` (A or B, default A) stays. */
    merge: (id: string, targetId?: string) =>
      send<CompanyMergeResult>(
        "POST",
        `/company-duplicates/${id}/merge`,
        targetId ? { targetId } : {},
      ),
    dismiss: (id: string) => request<void>(`/company-duplicates/${id}/dismiss`, { method: "POST" }),
    /** Contact rows: link to `companyId`, or (omitted) to a new company named after the observed text. */
    relink: (id: string, companyId?: string) =>
      send<{ leadId: string; companyId: string }>(
        "POST",
        `/company-duplicates/${id}/relink`,
        companyId ? { companyId } : {},
      ),
  },
  /** CRM v2 deals (B4 §4). Stage moves only through `moveStage`. */
  deals: {
    list: (params: DealListParams, cursor?: string, signal?: AbortSignal) =>
      get<Page<DealListItem>>(listQuery("/deals", { ...params, cursor }), signal),
    count: (params: Omit<DealListParams, "sort" | "limit">, signal?: AbortSignal) =>
      get<{ count: number }>(listQuery("/deals/count", params), signal),
    /** Every stage in pipeline order; `stage` is not allowed (400). */
    board: (params: Omit<DealListParams, "stage" | "sort" | "limit">, signal?: AbortSignal) =>
      get<{ data: DealBoardColumn[] }>(listQuery("/deals/board", params), signal),
    get: (id: string, signal?: AbortSignal) => get<DealDetail>(`/deals/${id}`, signal),
    create: (input: CreateDealInput) => send<DealDetail>("POST", "/deals", input),
    update: (id: string, input: UpdateDealInput) =>
      send<DealDetail>("PATCH", `/deals/${id}`, input),
    /** Lost needs `lossReason`; `contactAction` only with lost; the current stage → 409. */
    moveStage: (id: string, input: MoveDealStageInput) =>
      send<DealDetail>("POST", `/deals/${id}/stage`, input),
    /** Its own events + its linked meetings' and proposals', newest first (C4). */
    timeline: (id: string, kind: ActivityType[], cursor?: string, signal?: AbortSignal) =>
      get<Page<CompanyTimelineEvent>>(listQuery(`/deals/${id}/timeline`, { kind, cursor }), signal),
  },
  savedViews: {
    list: (object: SavedViewObject, signal?: AbortSignal) =>
      get<{ data: SavedView[] }>(query("/saved-views", { object }), signal),
    create: (input: SavedViewInput & { object: SavedViewObject; name: string }) =>
      send<SavedView>("POST", "/saved-views", input),
    update: (id: string, input: Omit<SavedViewInput, "object">) =>
      send<SavedView>("PATCH", `/saved-views/${id}`, input),
    delete: (id: string) => del(`/saved-views/${id}`),
  },
  me: (signal?: AbortSignal) =>
    get<{
      id: string;
      name: string;
      email: string;
      /** The global role: only /admin user management uses it (E4b); workspace roles are on Workspace. */
      role: "admin" | "salesperson";
      /** E3b-1: the user's booking page; null = none. */
      bookingUrl?: string | null;
      /** E4b: opens every workspace as admin; sees the super-admin page. */
      isSuperAdmin?: boolean;
      workspaces?: Workspace[];
    }>("/me", signal),
  /** E3b-1 rule 5: the signed-in user's own booking link. */
  updateMe: (input: { bookingUrl: string | null }) =>
    send<{ bookingUrl: string | null }>("PATCH", "/me", input),
  /** E4b: the current workspace's directory: members + non-member owners (`member: false`). */
  profiles: (signal?: AbortSignal) =>
    get<{ data: (Omit<User, "role"> & { role: WorkspaceRole; member: boolean })[] }>(
      "/profiles",
      signal,
    ),
  team: {
    list: (signal?: AbortSignal) => get<{ data: TeamMember[] }>("/team/members", signal),
    add: (input: { email: string; role: WorkspaceRole }) =>
      send<{ data: TeamMember[] }>("POST", "/team/members", input),
    setRole: (userId: string, role: WorkspaceRole) =>
      send<{ data: TeamMember[] }>("PATCH", `/team/members/${userId}`, { role }),
    remove: (userId: string) =>
      request<{ data: TeamMember[] }>(`/team/members/${userId}`, { method: "DELETE" }),
  },
  superAdmin: {
    memberships: (
      params: { cursor?: string | undefined; q?: string | undefined },
      signal?: AbortSignal,
    ) => get<MembershipPage>(listQuery("/super-admin/memberships", params), signal),
    setMembership: (input: { workspaceId: string; userId: string; role: WorkspaceRole | null }) =>
      send<{ data: TeamMember[] }>("PUT", "/super-admin/memberships", input),
  },
  admin: {
    users: {
      list: (signal?: AbortSignal) => get<{ data: AdminUser[] }>("/admin/users", signal),
      create: (input: { name: string; email: string; password: string }) =>
        send<AdminUser>("POST", "/admin/users", input),
      update: (
        id: string,
        input: {
          name?: string;
          email?: string;
          password?: string;
          active?: boolean;
          bookingUrl?: string | null;
        },
      ) => send<AdminUser>("PATCH", `/admin/users/${id}`, input),
    },
  },
  workspaces: {
    list: (signal?: AbortSignal) => get<{ data: Workspace[] }>("/workspaces", signal),
    create: (name: string) => send<Workspace>("POST", "/workspaces", { name }),
  },
  connections: {
    email: {
      get: (signal?: AbortSignal) => get<EmailSettings>("/connections/email/settings", signal),
      update: (input: EmailSettingsInput) =>
        send<EmailSettings>("PUT", "/connections/email/settings", input),
      testSmtp: () => send<EmailConnectionTest>("POST", "/connections/email/test-smtp"),
      testImap: () => send<EmailConnectionTest>("POST", "/connections/email/test-imap"),
      sendTest: () => send<TestEmailStatus>("POST", "/connections/email/test-send"),
      testStatus: (id: string, signal?: AbortSignal) =>
        get<TestEmailStatus>(`/connections/email/test-send/${encodeURIComponent(id)}`, signal),
      resume: () => send<EmailSettings>("POST", "/connections/email/resume"),
      /** D3 (admin): the worker reads the mailbox on its next tick. */
      checkNow: () => send<EmailSettings>("POST", "/connections/email/check-now"),
      setTrackOpens: (enabled: boolean) =>
        send<EmailSettings>("PUT", "/connections/email/track-opens", { enabled }),
      deliverability: (selector: string, signal?: AbortSignal) =>
        get<DeliverabilityCheck>(
          `/connections/email/deliverability${selector ? `?selector=${encodeURIComponent(selector)}` : ""}`,
          signal,
        ),
    },
    whatsapp: {
      get: (signal?: AbortSignal) =>
        get<WhatsAppConnection>("/connections/whatsapp/settings", signal),
      update: (input: WhatsAppSettingsInput) =>
        send<WhatsAppConnection>("PUT", "/connections/whatsapp/settings", input),
      addNumber: (input: { label?: string; ownerUserId?: string | null } = {}) =>
        send<WhatsAppConnection>("POST", "/connections/whatsapp/numbers", input),
      updateNumber: (id: string, input: WhatsAppNumberInput) =>
        send<WhatsAppConnection>("PUT", `/connections/whatsapp/numbers/${id}`, input),
      pauseNumber: (id: string, pause: boolean) =>
        send<WhatsAppConnection>(
          "POST",
          `/connections/whatsapp/numbers/${id}/${pause ? "pause" : "resume"}`,
        ),
      removeNumber: (id: string, input: RemoveWhatsAppNumberInput = {}) =>
        request<WhatsAppConnection>(`/connections/whatsapp/numbers/${id}`, {
          method: "DELETE",
          body: JSON.stringify(input),
        }),
      command: (numberId: string, command: "connect" | "restart" | "logout") =>
        send<WhatsAppConnection>("POST", `/connections/whatsapp/numbers/${numberId}/${command}`),
    },
    googleCalendar: {
      get: (signal?: AbortSignal) =>
        get<GoogleCalendarConnection>("/connections/google-calendar", signal),
      updateCredentials: (input: {
        clientId: string;
        clientSecret?: string;
        redirectUri: string;
      }) =>
        send<GoogleCalendarConnection>("PUT", "/connections/google-calendar/credentials", input),
      oauthStart: () => send<{ url: string }>("POST", "/connections/google-calendar/oauth/start"),
      disconnect: () =>
        send<GoogleCalendarConnection>("POST", "/connections/google-calendar/disconnect"),
    },
  },
  knowledge: {
    documents: {
      list: (signal?: AbortSignal) =>
        get<{ data: KnowledgeDocument[] }>("/knowledge/documents", signal),
      get: (id: string, signal?: AbortSignal) =>
        get<KnowledgeDocumentDetail>(`/knowledge/documents/${id}`, signal),
      createText: (input: { title: string; docType: string; tags: string[]; text: string }) =>
        send<KnowledgeDocumentDetail>("POST", "/knowledge/documents", input),
      /** Multipart: `file`, `docType`, optional `title` and comma-separated `tags`. */
      upload: (form: FormData) => uploadFile<KnowledgeDocumentDetail>("/knowledge/documents", form),
      update: (
        id: string,
        input: { title?: string; docType?: string; tags?: string[]; isActive?: boolean },
      ) => send<KnowledgeDocumentDetail>("PATCH", `/knowledge/documents/${id}`, input),
      reprocess: (id: string) =>
        send<KnowledgeDocumentDetail>("POST", `/knowledge/documents/${id}/reprocess`),
      remove: (id: string) => del(`/knowledge/documents/${id}`),
    },
    assets: {
      list: (signal?: AbortSignal) => get<{ data: KnowledgeAsset[] }>("/knowledge/assets", signal),
      /** Multipart: `file`, `title`, `useWhen`, comma-separated `tags` and `channels`. */
      create: (form: FormData) => uploadFile<KnowledgeAsset>("/knowledge/assets", form),
      update: (
        id: string,
        input: {
          title?: string;
          useWhen?: string;
          tags?: string[];
          channels?: string[];
          isActive?: boolean;
        },
      ) => send<KnowledgeAsset>("PATCH", `/knowledge/assets/${id}`, input),
      remove: (id: string) => del(`/knowledge/assets/${id}`),
    },
    search: (input: { query: string; docTypes?: string[]; tags?: string[]; limit?: number }) =>
      send<{ data: KnowledgeHit[] }>("POST", "/knowledge/search", input),
  },
  agent: {
    settings: {
      get: (signal?: AbortSignal) => get<AgentSettings>("/agent/settings", signal),
      update: (input: AgentSettingsUpdate) => send<AgentSettings>("PUT", "/agent/settings", input),
      livePreview: (scope: AgentLiveScope, signal?: AbortSignal) =>
        get<AgentLivePreview>(query("/agent/settings/live-preview", { scope }), signal),
      resetReadiness: () => send<AgentSettings>("POST", "/agent/settings/reset-readiness"),
    },
    playbooks: {
      list: (signal?: AbortSignal) =>
        get<{ currentVersion: number | null; data: AgentPlaybook[] }>("/agent/playbooks", signal),
      create: (body: string) => send<AgentPlaybook>("POST", "/agent/playbooks", { body }),
      restore: (version: number) =>
        send<AgentPlaybook>("POST", `/agent/playbooks/${version}/restore`),
    },
    decisions: {
      list: (filters: AgentDecisionFilters, cursor?: string, signal?: AbortSignal) =>
        get<{ data: AgentDecisionRow[]; nextCursor: string | null }>(
          query("/agent/decisions", { ...filters, cursor }),
          signal,
        ),
      get: (id: string, signal?: AbortSignal) =>
        get<AgentDecisionDetail>(`/agent/decisions/${id}`, signal),
      rate: (id: string, input: AgentRatingInput) =>
        send<AgentDecisionDetail>("PUT", `/agent/decisions/${id}/rating`, input),
      report: (id: string, note: string) =>
        send<AgentDecisionReport>("POST", `/agent/decisions/${id}/reports`, { note }),
    },
    /** Admin only. */
    resolveReport: (reportId: string, note?: string) =>
      send<AgentDecisionReport>("POST", `/agent/reports/${reportId}/resolve`, { note }),
    stats: (signal?: AbortSignal) => get<AgentStats>("/agent/stats", signal),
    leads: {
      panel: (leadId: string, signal?: AbortSignal) =>
        get<LeadAgentPanel>(`/agent/leads/${leadId}`, signal),
      /** Admin only; at most 500 ids per call. */
      enroll: (leadIds: string[]) =>
        send<{ data: AgentEnrollResult[] }>("POST", "/agent/leads/enroll", { leadIds }),
      pause: (leadId: string) => send<Lead>("POST", `/agent/leads/${leadId}/pause`),
      resume: (leadId: string) => send<Lead>("POST", `/agent/leads/${leadId}/resume`),
      stop: (leadId: string, note?: string) =>
        send<Lead>("POST", `/agent/leads/${leadId}/stop`, { note }),
      wake: (leadId: string) => send<{ wakeup: unknown }>("POST", `/agent/leads/${leadId}/wake`),
      /** Admin only (E2). */
      setLiveTest: (leadId: string, enabled: boolean) =>
        send<LeadAgentPanel>("PUT", `/agent/leads/${leadId}/live-test`, { enabled }),
    },
  },
  assignmentRules: {
    get: (signal?: AbortSignal) => get<AssignmentRules>("/assignment-rules", signal),
    replace: (input: { rules: AssignmentRuleInput[]; fallbackOwnerId: string | null }) =>
      send<AssignmentRules>("PUT", "/assignment-rules", input),
  },
  leads: {
    get: (id: string, signal?: AbortSignal) => get<Lead>(`/leads/${id}`, signal),
    create: (input: CreateLeadInput) => send<Lead>("POST", "/leads", input),
    importCsv: (rows: ImportLeadRow[]) =>
      send<{ data: ImportLeadsResult }>("POST", "/leads/import", { rows }),
    update: (id: string, fields: UpdateLeadInput) => send<Lead>("PATCH", `/leads/${id}`, fields),
    delete: (id: string) => del(`/leads/${id}`),
    addNote: (id: string, body: string) => send<LeadNote>("POST", `/leads/${id}/notes`, { body }),
    notes: (id: string, signal?: AbortSignal) =>
      get<{ data: LeadNote[] }>(`/leads/${id}/notes`, signal),
    contactability: (id: string, signal?: AbortSignal) =>
      get<{ data: Contactability[] }>(`/leads/${id}/contactability`, signal),
    setContactability: (
      id: string,
      input: { channel: Contactability["channel"]; status: string; reason?: string },
    ) => send<{ data: Contactability[] }>("POST", `/leads/${id}/contactability`, input),
    setAutomation: (id: string, mode: AutomationMode, reason?: string) =>
      send<Lead>("POST", `/leads/${id}/automation`, { mode, reason }),
    markDnc: (id: string, reason: string) => send<Lead>("POST", `/leads/${id}/dnc`, { reason }),
    reactivateFromDnc: (id: string, reason: string) =>
      send<Lead>("POST", `/leads/${id}/dnc/reactivate`, { reason }),
    markWon: (id: string, reason?: string) => send<Lead>("POST", `/leads/${id}/won`, { reason }),
    markLost: (id: string, lossReason: LeadLossReason, notes?: string) =>
      send<Lead>("POST", `/leads/${id}/lost`, { lossReason, notes }),
    discard: (id: string, reason?: string) =>
      send<Lead>("POST", `/leads/${id}/discard`, { reason }),
    reactivate: (id: string, reason?: string) =>
      send<Lead>("POST", `/leads/${id}/reactivate`, { reason }),
    longTermNurture: (id: string, reason?: string) =>
      send<Lead>("POST", `/leads/${id}/long-term-nurture`, { reason }),
    logCall: (id: string, input: LogCallInput) =>
      send<{
        call: Call;
        lead: Lead;
        workflowTrigger?: WorkflowTrigger;
        promptScheduleMeeting?: boolean;
      }>("POST", `/leads/${id}/calls`, input),
    logCommunication: (id: string, channel: "email" | "whatsapp", detail?: string) =>
      send<{ channel: string; title: string }>("POST", `/leads/${id}/communications`, {
        channel,
        detail,
      }),
  },
  tasks: {
    /** List standard (C6a). */
    page: (params: TaskListParams, cursor?: string, signal?: AbortSignal) =>
      get<Page<TaskListItem>>(listQuery("/tasks/list", { ...params, cursor }), signal),
    count: (params: TaskListParams, signal?: AbortSignal) =>
      get<{ count: number }>(listQuery("/tasks/count", { ...params }), signal),
    create: (input: CreateTaskInput) => send<Task>("POST", "/tasks", input),
    update: (id: string, input: UpdateTaskInput) => send<Task>("PATCH", `/tasks/${id}`, input),
    complete: (id: string) => send<Task>("POST", `/tasks/${id}/complete`),
    cancel: (id: string, reason?: string) => send<Task>("POST", `/tasks/${id}/cancel`, { reason }),
  },
  meetings: {
    page: (params: MeetingListParams, cursor?: string, signal?: AbortSignal) =>
      get<Page<MeetingListItem>>(listQuery("/meetings/list", { ...params, cursor }), signal),
    count: (params: MeetingListParams, signal?: AbortSignal) =>
      get<{ count: number }>(listQuery("/meetings/count", { ...params }), signal),
    create: (input: CreateMeetingInput) => send<Meeting>("POST", "/meetings", input),
    update: (id: string, input: UpdateMeetingInput) =>
      send<Meeting>("PATCH", `/meetings/${id}`, input),
    recordOutcome: (id: string, outcome: MeetingOutcome, notes?: string) =>
      send<Meeting>("POST", `/meetings/${id}/outcome`, { outcome, notes }),
  },
  proposals: {
    page: (params: ProposalListParams, cursor?: string, signal?: AbortSignal) =>
      get<Page<ProposalListItem>>(listQuery("/proposals/list", { ...params, cursor }), signal),
    count: (params: ProposalListParams, signal?: AbortSignal) =>
      get<{ count: number }>(listQuery("/proposals/count", { ...params }), signal),
    summary: (params: ProposalListParams, signal?: AbortSignal) =>
      get<ProposalSummary>(listQuery("/proposals/summary", { ...params }), signal),
    /** A 5-minute signed URL for the proposal's file (C6b); open it at once, never store it. */
    document: (id: string) => get<ProposalDocumentLink>(`/proposals/${id}/document`),
    create: (input: CreateProposalInput) => {
      const formData = new FormData();
      formData.append("leadId", input.leadId);
      formData.append("title", input.title);
      if (input.amount !== undefined) formData.append("amount", String(input.amount));
      if (input.notes) formData.append("notes", input.notes);
      formData.append("emailTemplateId", input.emailTemplateId);
      formData.append("whatsappTemplateId", input.whatsappTemplateId);
      formData.append("document", input.document);
      if (input.dealId) formData.append("dealId", input.dealId);
      return uploadFile<Proposal>("/proposals", formData);
    },
    update: (id: string, input: UpdateProposalInput) =>
      send<Proposal>("PATCH", `/proposals/${id}`, input),
    setStatus: (
      id: string,
      status: ProposalStatus,
      lossReason?: LeadLossReason,
      lossNotes?: string,
    ) => send<Proposal>("POST", `/proposals/${id}/status`, { status, lossReason, lossNotes }),
  },
  workflows: {
    list: (signal?: AbortSignal) => get<{ data: Workflow[] }>("/workflows", signal),
    get: (id: string, signal?: AbortSignal) => get<Workflow>(`/workflows/${id}`, signal),
    create: (input: CreateWorkflowInput) => send<Workflow>("POST", "/workflows", input),
    update: (id: string, input: UpdateWorkflowInput) =>
      send<Workflow>("PATCH", `/workflows/${id}`, input),
    createDraft: (id: string) => send<Workflow>("POST", `/workflows/${id}/draft`),
    updateSteps: (id: string, version: number, steps: WorkflowStep[]) =>
      send<Workflow>("PUT", `/workflows/${id}/versions/${version}/steps`, {
        steps: steps.map((step, order) => ({
          order,
          delayDays: step.delayDays,
          action: step.action,
          templateId: step.templateId ?? null,
          config: step.config ?? null,
          enabled: step.enabled,
        })),
      }),
    publish: (id: string, version: number) =>
      send<Workflow>("POST", `/workflows/${id}/versions/${version}/publish`, {
        enrollmentMode: "keep_existing",
      }),
    duplicate: (id: string) => send<Workflow>("POST", `/workflows/${id}/duplicate`),
    delete: (id: string, force?: boolean) => del(`/workflows/${id}${force ? "?force=true" : ""}`),
    deleteVersion: (id: string, version: number) =>
      request<Workflow>(`/workflows/${id}/versions/${version}`, { method: "DELETE" }),
  },
  templates: {
    list: (signal?: AbortSignal) => get<{ data: Template[] }>("/templates", signal),
    create: (input: CreateTemplateInput) => send<Template>("POST", "/templates", input),
    update: (id: string, input: UpdateTemplateInput) =>
      send<Template>("PATCH", `/templates/${id}`, input),
    delete: (id: string) => del(`/templates/${id}`),
    uploadAttachment: (templateId: string, file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return uploadFile<TemplateAttachment>(`/templates/${templateId}/attachments`, formData);
    },
    deleteAttachment: (templateId: string, attachmentId: string) =>
      del(`/templates/${templateId}/attachments/${attachmentId}`),
  },
  runs: {
    /** List standard (C6b). */
    page: (params: RunListParams, cursor?: string, signal?: AbortSignal) =>
      get<Page<RunListItem>>(listQuery("/runs/list", { ...params, cursor }), signal),
    count: (params: RunListParams, signal?: AbortSignal) =>
      get<{ count: number }>(listQuery("/runs/count", { ...params }), signal),
    create: (input: { leadId: string; workflowId: string; reason?: string | undefined }) =>
      send<{ data: Run[] }>("POST", "/runs", input),
    pause: (id: string, reason?: string) => send<Run>("POST", `/runs/${id}/pause`, { reason }),
    resume: (id: string) => send<Run>("POST", `/runs/${id}/resume`),
    cancel: (id: string, reason?: string) => send<Run>("POST", `/runs/${id}/cancel`, { reason }),
    retry: (id: string) => send<Run>("POST", `/runs/${id}/retry`),
  },
  scheduledActions: {
    page: (params: ScheduledActionListParams, cursor?: string, signal?: AbortSignal) =>
      get<Page<ScheduledActionListItem>>(
        listQuery("/scheduled-actions/list", { ...params, cursor }),
        signal,
      ),
    count: (params: ScheduledActionListParams, signal?: AbortSignal) =>
      get<{ count: number }>(listQuery("/scheduled-actions/count", { ...params }), signal),
  },
  home: {
    summary: (signal?: AbortSignal) => get<HomeSummary>("/home/summary", signal),
  },
  analytics: {
    funnel: (params: FunnelParams, signal?: AbortSignal) =>
      get<Funnel>(listQuery("/analytics/funnel", { ...params }), signal),
  },
  notifications: {
    list: (signal?: AbortSignal) => get<{ data: AppNotification[] }>("/notifications", signal),
    markAllRead: () => send<{ data: AppNotification[] }>("POST", "/notifications/read-all"),
  },
};
