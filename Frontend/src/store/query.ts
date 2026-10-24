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
};

export function refreshLead(client: QueryClient, workspaceId: string | null, leadId: string) {
  const targets = [
    keys.leads(workspaceId),
    keys.lead(workspaceId, leadId),
    keys.notes(workspaceId, leadId),
    keys.contactability(workspaceId, leadId),
    keys.calls(workspaceId, leadId),
    keys.timeline(workspaceId, leadId),
    keys.tasks(workspaceId),
    keys.meetings(workspaceId),
    keys.proposals(workspaceId),
    keys.runs(workspaceId),
    keys.scheduledActions(workspaceId),
    keys.notifications(workspaceId),
    keys.dashboard(workspaceId),
  ];
  return Promise.all(targets.map((queryKey) => client.invalidateQueries({ queryKey })));
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
