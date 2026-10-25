import type { ContactDetail, TimelineEvent } from "@/types";

/** Same default as the backend (`"<Company> – <service interest or New opportunity>"`). */
export const defaultDealName = (contact: ContactDetail) =>
  `${contact.company?.name ?? contact.companyText} – ${contact.serviceInterest || "New opportunity"}`;

export const ACTIVITY_FILTERS = [
  { id: "all", label: "All" },
  { id: "notes", label: "Notes" },
  { id: "calls", label: "Calls" },
  { id: "meetings", label: "Meetings" },
  { id: "tasks", label: "Tasks" },
  { id: "messages", label: "Messages" },
  { id: "ai", label: "AI" },
  { id: "deals", label: "Deals" },
  { id: "system", label: "System" },
] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]["id"];

/** Backend AGENT_ACTOR_NAME: AI agent rows (status changes, drafts, AI tasks). */
const AI_ACTOR = "AI Agent";

/** Which chip a timeline row belongs to (kinds written by the backend today). */
export function activityType(event: TimelineEvent): Exclude<ActivityFilter, "all"> {
  if (event.relatedDealId) return "deals";
  if (event.actor === AI_ACTOR) return "ai";
  switch (event.kind) {
    case "note":
      return "notes";
    case "call":
      return "calls";
    case "meeting":
    case "proposal":
      return "meetings";
    case "task":
      return "tasks";
    case "email":
    case "whatsapp":
      return "messages";
    default:
      // stage, system, workflow automation
      return "system";
  }
}
