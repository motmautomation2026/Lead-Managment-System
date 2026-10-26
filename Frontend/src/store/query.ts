import type { QueryClient } from "@tanstack/react-query";
import { BackendError } from "@/lib/backend-client";

// Workspace-scoped keys take the current workspace id as their first
// argument and fold it into the key so TanStack Query's cache naturally
// separates data per workspace — switching workspaces changes the key,
// which triggers a fresh fetch instead of momentarily showing the previous
// workspace's cached data. `session`/`profiles`/`workspaces` are
// workspace-agnostic (you need them before a workspace is even selected) and
// stay plain keys.
export const keys = {
  session: ["session"] as const,
  profiles: ["profiles"] as const,
  workspaces: ["workspaces"] as const,
  leads: (workspaceId: string | null) => ["leads", workspaceId] as const,
  search: (workspaceId: string | null, q: string) => ["search", workspaceId, q] as const,
  lead: (workspaceId: string | null, id: string) => ["lead", workspaceId, id] as const,
  notes: (workspaceId: string | null, id: string) => ["notes", workspaceId, id] as const,
  contactability: (workspaceId: string | null, id: string) =>
    ["contactability", workspaceId, id] as const,
  calls: (workspaceId: string | null, id: string) => ["calls", workspaceId, id] as const,
  timeline: (workspaceId: string | null, id: string) => ["timeline", workspaceId, id] as const,
  tasks: (workspaceId: string | null) => ["tasks", workspaceId] as const,
  meetings: (workspaceId: string | null) => ["meetings", workspaceId] as const,
  proposals: (workspaceId: string | null) => ["proposals", workspaceId] as const,
  workflows: (workspaceId: string | null) => ["workflows", workspaceId] as const,
  templates: (workspaceId: string | null) => ["templates", workspaceId] as const,
  runs: (workspaceId: string | null) => ["runs", workspaceId] as const,
  scheduledActions: (workspaceId: string | null) => ["scheduledActions", workspaceId] as const,
  dashboard: (workspaceId: string | null) => ["dashboard", workspaceId] as const,
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
  /** Every deal query (lists/records land in C4). */
  deals: (workspaceId: string | null) => ["deals", workspaceId] as const,
  /** Without params: the prefix of every companies list / count in the workspace. */
  companies: (workspaceId: string | null, params?: object) =>
    params ? (["companies", workspaceId, params] as const) : (["companies", workspaceId] as const),
  companiesCount: (workspaceId: string | null, params?: object) =>
    params
      ? (["companiesCount", workspaceId, params] as const)
      : (["companiesCount", workspaceId] as const),
  company: (workspaceId: string | null, id: string) => ["company", workspaceId, id] as const,
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
  savedViews: (workspaceId: string | null, object: string) =>
    ["savedViews", workspaceId, object] as const,
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
 * count, timeline, tasks, meetings, proposals, deals, automation, AI panel, dashboard,
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
        keys.calls(workspaceId, leadId),
        keys.timeline(workspaceId, leadId),
        keys.contactTimeline(workspaceId, leadId),
        keys.agentLeadPanel(workspaceId, leadId),
      ]
    : [
        "lead",
        "contact",
        "notes",
        "contactability",
        "calls",
        "timeline",
        "contactTimeline",
        "agentLeadPanel",
      ].map((prefix) => [prefix, workspaceId]);
  const targets = [
    ...perContact,
    keys.leads(workspaceId),
    keys.contacts(workspaceId),
    keys.contactsCount(workspaceId),
    keys.deals(workspaceId),
    keys.tasks(workspaceId),
    keys.meetings(workspaceId),
    keys.proposals(workspaceId),
    keys.runs(workspaceId),
    keys.scheduledActions(workspaceId),
    keys.notifications(workspaceId),
    keys.dashboard(workspaceId),
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
