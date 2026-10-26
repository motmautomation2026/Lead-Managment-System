import type { ContactDetail } from "@/types";

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
/** "all" or a server-side activity type (`kind` on the paginated timelines). */
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]["id"];
