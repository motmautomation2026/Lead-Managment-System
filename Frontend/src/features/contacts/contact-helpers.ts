import type { ActivityType, ContactDetail } from "@/types";

/** Same default as the backend (`"<Company> – <service interest or New opportunity>"`). */
export const defaultDealName = (contact: ContactDetail) =>
  `${contact.company?.name ?? contact.companyText} – ${contact.serviceInterest || "New opportunity"}`;

/**
 * UX-3 Activity chips; each sends one or more server kinds (`kind` on the paginated timelines, B4).
 * Meetings & proposals also holds the LL-2 meeting reminders sent to the lead.
 */
export const ACTIVITY_FILTERS = [
  { id: "all", label: "All", kinds: [] },
  { id: "calls", label: "Calls", kinds: ["calls"] },
  { id: "messages", label: "Messages", kinds: ["messages"] },
  { id: "notes", label: "Notes", kinds: ["notes"] },
  { id: "ai", label: "AI", kinds: ["ai"] },
  { id: "meetings", label: "Meetings & proposals", kinds: ["meetings", "proposals"] },
  { id: "system", label: "System", kinds: ["system", "tasks", "deals"] },
] as const satisfies readonly { id: string; label: string; kinds: readonly ActivityType[] }[];
/** "all" or one chip of ACTIVITY_FILTERS. */
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]["id"];

/** D2 deep link into a contact record: open a tab, pre-filter Activity, scroll to the newest reply. */
export interface ContactRecordSearch {
  tab?: string | undefined;
  activity?: ActivityFilter | undefined;
  reply?: "latest" | undefined;
}
export function validateContactRecordSearch(search: Record<string, unknown>): ContactRecordSearch {
  return {
    tab: typeof search["tab"] === "string" ? search["tab"] : undefined,
    activity: ACTIVITY_FILTERS.find((f) => f.id === search["activity"])?.id,
    reply: search["reply"] === "latest" ? "latest" : undefined,
  };
}
