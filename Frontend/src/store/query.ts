import type { QueryClient } from "@tanstack/react-query";
import { BackendError } from "@/lib/backend-client";

type WorkObject = "tasks" | "meetings" | "proposals";

// Workspace-scoped keys take the current workspace id as their first
// argument and fold it into the key so TanStack Query's cache naturally
// separates data per workspace — switching workspaces changes the key,
// which triggers a fresh fetch instead of momentarily showing the previous
// workspace's cached data. `session`/`workspaces` are workspace-agnostic
// (you need them before a workspace is even selected) and stay plain keys.
export const keys = {
  session: ["session"] as const,
  /** E4b: the directory is per workspace (members + non-member owners). */
  profiles: (workspaceId: string | null) => ["profiles", workspaceId] as const,
  team: (workspaceId: string | null) => ["team", workspaceId] as const,
  memberships: (q: string) => ["memberships", q] as const,
  systemHealth: ["system-health"] as const,
  workspaces: ["workspaces"] as const,
  search: (workspaceId: string | null, q: string) => ["search", workspaceId, q] as const,
  lead: (workspaceId: string | null, id: string) => ["lead", workspaceId, id] as const,
  notes: (workspaceId: string | null, id: string) => ["notes", workspaceId, id] as const,
  contactability: (workspaceId: string | null, id: string) =>
    ["contactability", workspaceId, id] as const,
  workflows: (workspaceId: string | null) => ["workflows", workspaceId] as const,
  templates: (workspaceId: string | null) => ["templates", workspaceId] as const,
  runs: (workspaceId: string | null) => ["runs", workspaceId] as const,
  scheduledActions: (workspaceId: string | null) => ["scheduledActions", workspaceId] as const,
  notifications: (workspaceId: string | null) => ["notifications", workspaceId] as const,
  knowledgeDocuments: (workspaceId: string | null) => ["knowledgeDocuments", workspaceId] as const,
  knowledgeDocument: (workspaceId: string | null, id: string) =>
    ["knowledgeDocument", workspaceId, id] as const,
  knowledgeAssets: (workspaceId: string | null) => ["knowledgeAssets", workspaceId] as const,
  agentSettings: (workspaceId: string | null) => ["agentSettings", workspaceId] as const,
  agentPlaybooks: (workspaceId: string | null) => ["agentPlaybooks", workspaceId] as const,
  /** Without filters: the prefix of every decisions list in the workspace (for invalidation). */
  agentDecisions: (workspaceId: string | null, filters?: object) =>
    filters
      ? (["agentDecisions", workspaceId, filters] as const)
      : (["agentDecisions", workspaceId] as const),
  agentDecision: (workspaceId: string | null, id: string) =>
    ["agentDecision", workspaceId, id] as const,
  agentStats: (workspaceId: string | null) => ["agentStats", workspaceId] as const,
  /** Without a lead id: the prefix of every lead AI panel in the workspace. */
  agentLeadPanel: (workspaceId: string | null, leadId?: string) =>
    leadId
      ? (["agentLeadPanel", workspaceId, leadId] as const)
      : (["agentLeadPanel", workspaceId] as const),
  /** Without params: the prefix of every contacts list / count in the workspace. */
  contacts: (workspaceId: string | null, params?: object) =>
    params ? (["contacts", workspaceId, params] as const) : (["contacts", workspaceId] as const),
  contactsCount: (workspaceId: string | null, params?: object) =>
    params
      ? (["contactsCount", workspaceId, params] as const)
      : (["contactsCount", workspaceId] as const),
  contact: (workspaceId: string | null, id: string) => ["contact", workspaceId, id] as const,
  /** Every deal query shares this prefix: `deals(ws)` alone invalidates lists, counts, board, records, feeds. */
  deals: (workspaceId: string | null) => ["deals", workspaceId] as const,
  dealList: (workspaceId: string | null, params: object) =>
    ["deals", workspaceId, "list", params] as const,
  dealCount: (workspaceId: string | null, params: object) =>
    ["deals", workspaceId, "count", params] as const,
  dealBoard: (workspaceId: string | null, params: object) =>
    ["deals", workspaceId, "board", params] as const,
  deal: (workspaceId: string | null, id: string) => ["deals", workspaceId, "detail", id] as const,
  dealTimeline: (workspaceId: string | null, id: string, extra: object) =>
    ["deals", workspaceId, "timeline", id, extra] as const,
  contactSearch: (workspaceId: string | null, q: string, companyId?: string) =>
    ["contactSearch", workspaceId, q, companyId ?? null] as const,
  /** Without params: the prefix of every companies list / count in the workspace. */
  companies: (workspaceId: string | null, params?: object) =>
    params ? (["companies", workspaceId, params] as const) : (["companies", workspaceId] as const),
  companiesCount: (workspaceId: string | null, params?: object) =>
    params
      ? (["companiesCount", workspaceId, params] as const)
      : (["companiesCount", workspaceId] as const),
  company: (workspaceId: string | null, id: string) => ["company", workspaceId, id] as const,
  companyIndustries: (workspaceId: string | null) =>
    ["companies", workspaceId, "industries"] as const,
  /** Per company; `extra` (params / kinds) is left off for the company-wide prefix. */
  companyContacts: (workspaceId: string | null, id: string, extra?: object) =>
    extra
      ? (["companyContacts", workspaceId, id, extra] as const)
      : (["companyContacts", workspaceId, id] as const),
  companyDeals: (workspaceId: string | null, id: string, extra?: object) =>
    extra
      ? (["companyDeals", workspaceId, id, extra] as const)
      : (["companyDeals", workspaceId, id] as const),
  companyTimeline: (workspaceId: string | null, id: string, extra?: object) =>
    extra
      ? (["companyTimeline", workspaceId, id, extra] as const)
      : (["companyTimeline", workspaceId, id] as const),
  contactTimeline: (workspaceId: string | null, id: string, extra?: object) =>
    extra
      ? (["contactTimeline", workspaceId, id, extra] as const)
      : (["contactTimeline", workspaceId, id] as const),
  inboundReply: (workspaceId: string | null, contactId: string, messageId: string) =>
    ["inboundReply", workspaceId, contactId, messageId] as const,
  latestReplyDraft: (workspaceId: string | null, contactId: string) =>
    ["latestReplyDraft", workspaceId, contactId] as const,
  companyDuplicates: (workspaceId: string | null, params?: object) =>
    params
      ? (["companyDuplicates", workspaceId, params] as const)
      : (["companyDuplicates", workspaceId] as const),
  companyDuplicatesCount: (workspaceId: string | null, params?: object) =>
    params
      ? (["companyDuplicatesCount", workspaceId, params] as const)
      : (["companyDuplicatesCount", workspaceId] as const),
  companySearch: (workspaceId: string | null, q: string) =>
    ["companySearch", workspaceId, q] as const,
  /** Every Tasks/Meetings/Proposals list query (C6a) shares this prefix. */
  work: (workspaceId: string | null) => ["work", workspaceId] as const,
  workList: (workspaceId: string | null, object: WorkObject, params: object) =>
    ["work", workspaceId, object, "list", params] as const,
  workCount: (workspaceId: string | null, object: WorkObject, params: object) =>
    ["work", workspaceId, object, "count", params] as const,
  proposalSummary: (workspaceId: string | null, params: object) =>
    ["work", workspaceId, "proposals", "summary", params] as const,
  savedViews: (workspaceId: string | null, object: string) =>
    ["savedViews", workspaceId, object] as const,
  /** Runs + Scheduled steps lists (C6b) share the old `runs` / `scheduledActions` prefixes. */
  runList: (workspaceId: string | null, params: object) =>
    ["runs", workspaceId, "list", params] as const,
  runCount: (workspaceId: string | null, params: object) =>
    ["runs", workspaceId, "count", params] as const,
  scheduledActionList: (workspaceId: string | null, params: object) =>
    ["scheduledActions", workspaceId, "list", params] as const,
  scheduledActionCount: (workspaceId: string | null, params: object) =>
    ["scheduledActions", workspaceId, "count", params] as const,
  home: (workspaceId: string | null) => ["home", workspaceId] as const,
  // Settings / Admin / auth (A17: these used to be defined in the pages).
  connection: (workspaceId: string | null, kind: "email" | "whatsapp" | "google-calendar") =>
    ["connections", kind, workspaceId] as const,
  assignmentRules: (workspaceId: string | null) => ["assignment-rules", workspaceId] as const,
  adminUsers: ["admin", "users"] as const,
  authRole: (userId: string | undefined) => ["auth", "role", userId] as const,
};

// Company queries that show contact data (counts, last activity, contact rows, the feed).
const COMPANY_VIEWS = [
  "companies",
  "companiesCount",
  "company",
  "companyContacts",
  "companyDeals",
  "companyTimeline",
];

/**
 * After any write that touches a contact (lead): its record, every contacts list and
 * count, timeline, the work lists (tasks, meetings, proposals), deals,
 * automation (runs, scheduled steps), AI panel, Home,
 * and the company views that show contacts.
 * Without `leadId` (bulk actions) every contact's record queries are refreshed.
 */
export function refreshContact(client: QueryClient, workspaceId: string | null, leadId?: string) {
  const perContact = leadId
    ? [
        keys.lead(workspaceId, leadId),
        keys.contact(workspaceId, leadId),
        keys.notes(workspaceId, leadId),
        keys.contactability(workspaceId, leadId),
        keys.contactTimeline(workspaceId, leadId),
        keys.agentLeadPanel(workspaceId, leadId),
        keys.latestReplyDraft(workspaceId, leadId),
      ]
    : [
        "lead",
        "contact",
        "notes",
        "contactability",
        "contactTimeline",
        "agentLeadPanel",
        "latestReplyDraft",
      ].map((prefix) => [prefix, workspaceId]);
  const targets = [
    ...perContact,
    keys.contacts(workspaceId),
    keys.contactsCount(workspaceId),
    ["contactSearch", workspaceId],
    keys.deals(workspaceId),
    keys.work(workspaceId),
    keys.runs(workspaceId),
    keys.scheduledActions(workspaceId),
    keys.notifications(workspaceId),
    keys.home(workspaceId),
    ...COMPANY_VIEWS.map((prefix) => [prefix, workspaceId]),
  ];
  return Promise.all(targets.map((queryKey) => client.invalidateQueries({ queryKey })));
}

/**
 * After any company write (create, edit, rename, merge, duplicate actions). A rename or
 * merge changes other companies and contacts too, so this refreshes every company view
 * and every contact (refreshContact), plus company search, global search and duplicates.
 */
export function refreshCompany(client: QueryClient, workspaceId: string | null) {
  const targets = [
    keys.companyDuplicates(workspaceId),
    keys.companyDuplicatesCount(workspaceId),
    ["companySearch", workspaceId],
    ["search", workspaceId],
  ];
  return Promise.all([
    ...targets.map((queryKey) => client.invalidateQueries({ queryKey })),
    refreshContact(client, workspaceId),
  ]);
}

/**
 * After any deal write (create, edit, stage move): every deal query (lists, counts, board,
 * records, feeds), and — since a move can change its contact (won, lost, nurture) and the
 * company's open totals — every contact and company view (refreshCompany), plus global search.
 */
export function refreshDeal(client: QueryClient, workspaceId: string | null) {
  return refreshCompany(client, workspaceId);
}

/**
 * After any task / meeting / proposal write (C6a): every work list, count and summary, and
 * — since calls, outcomes and proposal statuses move the contact and its deals — every
 * contact, company and deal view (refreshDeal → refreshCompany → refreshContact).
 */
export function refreshWork(client: QueryClient, workspaceId: string | null) {
  return refreshDeal(client, workspaceId);
}

interface ErrorDetails {
  fieldErrors?: Record<string, string[] | undefined>;
  formErrors?: string[];
  requestId?: unknown;
}

/** "firstName" / "owner_id" → "First name" / "Owner id", for listing invalid fields. */
function fieldLabel(field: string) {
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.]/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The text every toast and error block shows for a failed request: the
 * backend's message, then any per-field problems from a 400, then the
 * support reference of an unexpected 500 ("Reference: …").
 */
export function messageFromError(error: unknown) {
  if (!(error instanceof Error)) return "The request failed.";
  let text = error.message || "The request failed.";
  if (error instanceof BackendError && error.details && typeof error.details === "object") {
    const details = error.details as ErrorDetails;
    const problems = [
      ...(details.formErrors ?? []),
      ...Object.entries(details.fieldErrors ?? {})
        .filter(([, messages]) => messages?.length)
        .map(([field, messages]) => `${fieldLabel(field)}: ${messages!.join(", ")}`),
    ];
    if (problems.length) text = `${text} ${problems.join("; ")}`;
    if (typeof details.requestId === "string" && !text.includes(details.requestId)) {
      text = `${text} Reference: ${details.requestId}`;
    }
  }
  return text;
}
