import type { ContactDetail } from "@/types";

/** Same default as the backend (`"<Company> – <service interest or New opportunity>"`). */
export const defaultDealName = (contact: ContactDetail) =>
  `${contact.company?.name ?? contact.companyText} – ${contact.serviceInterest || "New opportunity"}`;

export const ACTIVITY_FILTERS = [
  { id: "all", label: "All" },
  { id: "notes", label: "Notes" },
  { id: "calls", label: "Calls" },
  { id: "meetings", label: "Meetings" },
  { id: "proposals", label: "Proposals" },
  { id: "tasks", label: "Tasks" },
  { id: "messages", label: "Messages" },
  { id: "ai", label: "AI" },
  { id: "deals", label: "Deals" },
  { id: "system", label: "System" },
] as const;
/** "all" or a server-side activity type (`kind` on the paginated timelines). */
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
