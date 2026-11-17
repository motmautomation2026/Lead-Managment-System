import { z } from "zod";

/**
 * UX-1: Settings has one route per section (`/settings/<id>`). `access`: everyone; `admin` of THIS workspace (E4b);
 * `users` = user accounts (global admin or super-admin); `super` = super-admins only. Sections the viewer can't use
 * are hidden, not disabled. `workspace`: needs a selected workspace.
 */
export type SettingsAccess = "all" | "admin" | "users" | "super";
export const SETTINGS_GROUPS = ["Workspace", "Channels", "AI", "Personal", "Admin"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export const SETTINGS_SECTIONS = [
  // E4b rule 9: this workspace's members.
  { id: "team", group: "Workspace", label: "Team", access: "admin", workspace: true },
  {
    id: "assignment",
    group: "Workspace",
    label: "Lead assignment",
    access: "admin",
    workspace: true,
  },
  { id: "email", group: "Channels", label: "Email", access: "all", workspace: true },
  { id: "whatsapp", group: "Channels", label: "WhatsApp", access: "all", workspace: true },
  { id: "calendar", group: "Channels", label: "Google Calendar", access: "all", workspace: true },
  { id: "ai-agent", group: "AI", label: "AI agent", access: "admin", workspace: true },
  { id: "ai-limits", group: "AI", label: "Limits & schedule", access: "admin", workspace: true },
  // E2b: everyone sees the message rules (read-only for non-admins).
  { id: "message-rules", group: "AI", label: "Message rules", access: "all", workspace: true },
  { id: "playbook", group: "AI", label: "Playbook", access: "admin", workspace: true },
  { id: "style", group: "AI", label: "Style examples", access: "admin", workspace: true },
  { id: "industries", group: "AI", label: "Target industries", access: "admin", workspace: true },
  // E3b-1: everyone's own booking link.
  { id: "profile", group: "Personal", label: "My profile", access: "all", workspace: false },
  { id: "appearance", group: "Personal", label: "Appearance", access: "all", workspace: false },
  { id: "users", group: "Admin", label: "User accounts", access: "users", workspace: false },
  // E4b rule 10: every workspace × user.
  { id: "workspaces", group: "Admin", label: "All workspaces", access: "super", workspace: false },
  // P7: worker heartbeats and every workspace's queues, pauses, failures and AI budget.
  { id: "health", group: "Admin", label: "System health", access: "super", workspace: false },
] as const satisfies ReadonlyArray<{
  id: string;
  group: SettingsGroup;
  label: string;
  access: SettingsAccess;
  workspace: boolean;
}>;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Where a desktop `/settings` lands. Everyone may open it. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "email";

export const settingsPath = (id: SettingsSectionId) => `/settings/${id}` as const;

export interface SettingsViewer {
  isAdmin: boolean;
  canManageUsers: boolean;
  isSuperAdmin: boolean;
}
export const canOpen = (access: SettingsAccess, v: SettingsViewer) =>
  access === "all" ||
  (access === "admin" && v.isAdmin) ||
  (access === "users" && v.canManageUsers) ||
  (access === "super" && v.isSuperAdmin);

export const visibleSections = (v: SettingsViewer) =>
  SETTINGS_SECTIONS.filter((s) => canOpen(s.access, v));

export function sectionForPath(pathname: string): SettingsSection | null {
  const id = pathname.replace(/\/+$/, "").split("/")[2];
  return SETTINGS_SECTIONS.find((s) => s.id === id) ?? null;
}

/**
 * The Settings search: a setting's name → its section, tab (`?tab=`) and field (`#id`, focused after the jump).
 * Section names match too. Keep anchors equal to the field ids in the sections.
 */
export interface SettingEntry {
  label: string;
  section: SettingsSectionId;
  tab?: string;
  anchor?: string;
  keywords?: string;
  /** Narrower than its section (e.g. an admin-only card in a section everyone opens). */
  access?: SettingsAccess;
}
export const SETTING_ENTRIES: SettingEntry[] = [
  { label: "Add a member", section: "team", anchor: "team-add", keywords: "invite user role" },
  { label: "Member roles", section: "team", keywords: "admin salesperson remove" },
  { label: "Revenue rules", section: "assignment", keywords: "owner crore lead routing" },
  {
    label: "Default owner",
    section: "assignment",
    anchor: "assignment-fallback",
    keywords: "website fallback unassigned",
  },
  {
    label: "SMTP host",
    section: "email",
    tab: "connection",
    anchor: "email-smtpHost",
    keywords: "server mailbox",
  },
  {
    label: "From address",
    section: "email",
    tab: "connection",
    anchor: "email-fromAddress",
    keywords: "sender",
  },
  { label: "Reply-to", section: "email", tab: "connection", anchor: "email-replyTo" },
  {
    label: "IMAP host",
    section: "email",
    tab: "connection",
    anchor: "email-imapHost",
    keywords: "replies bounces inbox",
  },
  {
    label: "Test SMTP login",
    section: "email",
    tab: "connection",
    keywords: "test send check mailbox",
  },
  {
    label: "Email daily cap",
    section: "email",
    tab: "safety",
    anchor: "email-dailyCap",
    keywords: "limit",
  },
  {
    label: "Email hourly cap",
    section: "email",
    tab: "safety",
    anchor: "email-hourlyCap",
    keywords: "limit",
  },
  {
    label: "Email spacing",
    section: "email",
    tab: "safety",
    anchor: "email-minDelaySeconds",
    keywords: "delay seconds",
  },
  {
    label: "Email send window",
    section: "email",
    tab: "safety",
    anchor: "email-window-start",
    keywords: "hours days",
  },
  { label: "Mailbox already warmed up", section: "email", tab: "safety", keywords: "warm-up" },
  { label: "Email sending on/off", section: "email", tab: "safety", keywords: "enabled pause" },
  {
    label: "Email replies & bounces",
    section: "email",
    tab: "replies",
    keywords: "imap check now unsubscribes",
  },
  {
    label: "Email monitoring",
    section: "email",
    tab: "monitoring",
    keywords: "sent failures safety events",
  },
  {
    label: "Deliverability check",
    section: "email",
    tab: "deliverability",
    anchor: "email-dkim-selector",
    keywords: "dns spf dkim dmarc mx",
  },
  {
    label: "Track email opens",
    section: "email",
    tab: "deliverability",
    anchor: "track-opens",
    keywords: "pixel open tracking",
  },
  {
    label: "WhatsApp numbers",
    section: "whatsapp",
    tab: "numbers",
    keywords: "pair qr connect add number",
  },
  {
    label: "WhatsApp send window",
    section: "whatsapp",
    tab: "safety",
    anchor: "wa-window-start",
    keywords: "hours days",
  },
  { label: "Max WhatsApp numbers", section: "whatsapp", tab: "safety", anchor: "wa-maxNumbers" },
  {
    label: "WhatsApp outbound on/off",
    section: "whatsapp",
    tab: "safety",
    keywords: "master switch enabled",
  },
  {
    label: "WhatsApp monitoring",
    section: "whatsapp",
    tab: "monitoring",
    keywords: "safety events stop failures inbound review",
  },
  {
    label: "Google OAuth client",
    section: "calendar",
    anchor: "calendar-client-id",
    keywords: "credentials secret redirect",
  },
  { label: "Connect Google Calendar", section: "calendar", keywords: "meet link" },
  {
    label: "Meeting reminders to leads",
    section: "calendar",
    anchor: "meeting-reminders",
    keywords: "24 hours 1 hour reminder lead meeting",
    access: "admin",
  },
  { label: "AI mode", section: "ai-agent", keywords: "off shadow live scope go-live gate" },
  {
    label: "AI send window",
    section: "ai-limits",
    anchor: "agent-window-start",
    keywords: "days hours",
  },
  {
    label: "AI monthly budget",
    section: "ai-limits",
    anchor: "agent-monthlyBudgetUsd",
    keywords: "cost usd",
  },
  {
    label: "Max AI decisions per day",
    section: "ai-limits",
    anchor: "agent-maxDecisionsPerDay",
    keywords: "cap",
  },
  {
    label: "AI models",
    section: "ai-limits",
    anchor: "agent-decision-model",
    keywords: "decision grounding gpt",
  },
  { label: "Auto-enroll new leads", section: "ai-limits", keywords: "ai" },
  { label: "First message channel", section: "ai-limits", keywords: "whatsapp email" },
  {
    label: "Opt-out text",
    section: "ai-limits",
    anchor: "agent-email-opt-out",
    keywords: "unsubscribe stop",
  },
  { label: "Company name in AI messages", section: "ai-limits", anchor: "agent-company-name" },
  {
    label: "Banned phrases",
    section: "message-rules",
    anchor: "rules-banned",
    keywords: "ai words",
  },
  {
    label: "Word limits",
    section: "message-rules",
    anchor: "rules-whatsapp-words",
    keywords: "max words",
  },
  { label: "Playbook", section: "playbook", keywords: "ai instructions versions history" },
  {
    label: "Style examples",
    section: "style",
    anchor: "agent-style-examples",
    keywords: "tone writing",
  },
  {
    label: "Target industries",
    section: "industries",
    anchor: "agent-target-industries",
    keywords: "hot lead score fit",
  },
  {
    label: "Booking link",
    section: "profile",
    anchor: "profile-booking-url",
    keywords: "calendly call",
  },
  // LL-2 rule 3: staff email alerts + morning digest.
  {
    label: "Email me urgent alerts",
    section: "profile",
    anchor: "profile-emailAlertsEnabled",
    keywords: "notifications email reply escalation",
  },
  {
    label: "Morning digest",
    section: "profile",
    anchor: "profile-emailDigestEnabled",
    keywords: "email daily summary",
  },
  { label: "Theme", section: "appearance", keywords: "dark light mode" },
  { label: "Density", section: "appearance", keywords: "compact comfortable" },
  {
    label: "Create user account",
    section: "users",
    anchor: "users-create",
    keywords: "salesperson password",
  },
  { label: "Deactivate a user", section: "users", keywords: "reactivate" },
  { label: "Create a workspace", section: "workspaces", anchor: "new-workspace-name" },
  { label: "Memberships", section: "workspaces", keywords: "role workspace user" },
  { label: "Worker health", section: "health", keywords: "heartbeat stuck queues budget" },
];

/** Section names first, then settings; matched on label + keywords (every word must match). */
export function searchSettings(query: string, v: SettingsViewer, max = 8): SettingEntry[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const open = new Set<string>(visibleSections(v).map((s) => s.id));
  const sections: SettingEntry[] = SETTINGS_SECTIONS.map((s) => ({
    label: s.label,
    section: s.id,
    keywords: s.group,
  }));
  return [...sections, ...SETTING_ENTRIES]
    .filter((e) => open.has(e.section) && (!e.access || canOpen(e.access, v)))
    .filter((e) => {
      const text = `${e.label} ${e.keywords ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .slice(0, max);
}

// --- Old URLs (before UX-1: `/settings?tab=…`, `/admin`) -----------------------------------------

const LEGACY_TABS: Record<string, SettingsSectionId> = {
  workspace: "email",
  assignment: "assignment",
  agent: "ai-agent",
  team: "team",
  users: "users",
  workspaces: "workspaces",
  health: "health",
  profile: "profile",
  appearance: "appearance",
};

/**
 * `calendar` / `message` are the Google Calendar OAuth result (A5: the backend redirects to `/admin?calendar=…`);
 * the Calendar section shows the toast and strips them.
 */
export const settingsIndexSearchSchema = z.object({
  tab: z.string().optional(),
  calendar: z.string().optional(),
  message: z.string().optional(),
});
export type SettingsIndexSearch = z.infer<typeof settingsIndexSearchSchema>;
export const validateSettingsIndexSearch = (
  search: Record<string, unknown>,
): SettingsIndexSearch => {
  const parsed = settingsIndexSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};

export const calendarSearchSchema = z.object({
  calendar: z.string().optional(),
  message: z.string().optional(),
});
export const validateCalendarSearch = (search: Record<string, unknown>) => {
  const parsed = calendarSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};
/** `/admin` takes the same query as the Calendar OAuth landing. */
export const validateAdminSearch = validateCalendarSearch;

export interface SettingsRedirect {
  section: SettingsSectionId;
  search: { calendar?: string; message?: string };
}

/** Where an old `/settings?tab=…` URL goes; null = no legacy params (show the section list / default). */
export function legacySettingsRedirect(search: SettingsIndexSearch): SettingsRedirect | null {
  if (search.calendar)
    return {
      section: "calendar",
      search: { calendar: search.calendar, ...(search.message ? { message: search.message } : {}) },
    };
  const section = search.tab ? LEGACY_TABS[search.tab] : undefined;
  return section ? { section, search: {} } : null;
}

/** Where `/admin` goes: the Calendar OAuth landing keeps its query; else User accounts. */
export function adminRedirect(search: {
  calendar?: string | undefined;
  message?: string | undefined;
}): SettingsRedirect {
  return legacySettingsRedirect(search) ?? { section: "users", search: {} };
}

/** `?tab=` of a section with tabs; unknown values fall back to the section's first tab. */
export const tabSearch = <T extends readonly [string, ...string[]]>(tabs: T) =>
  z.object({ tab: z.enum(tabs).optional().catch(undefined) });

export const EMAIL_TABS = [
  "connection",
  "safety",
  "replies",
  "monitoring",
  "deliverability",
] as const;
export const validateEmailSearch = (search: Record<string, unknown>) =>
  tabSearch(EMAIL_TABS).parse(search);

export const WHATSAPP_TABS = ["numbers", "safety", "monitoring"] as const;
const whatsappSearchSchema = tabSearch(WHATSAPP_TABS).extend({
  number: z.string().uuid().optional().catch(undefined),
});
export const validateWhatsAppSearch = (search: Record<string, unknown>) =>
  whatsappSearchSchema.parse(search);

/** `<title>` + description of a Settings section route. */
export function settingsHead(label: string) {
  return () => ({
    meta: [
      { title: `${label} · Settings - MOTM Flow` },
      { name: "description", content: `${label} settings.` },
    ],
  });
}

/** ⌘K: frequent Settings actions (beside "Settings → <section>"). */
export const SETTINGS_PALETTE_ACTIONS: Array<
  Pick<SettingEntry, "section" | "tab" | "anchor"> & { label: string; access: SettingsAccess }
> = [
  { label: "Add a team member", section: "team", anchor: "team-add", access: "admin" },
  { label: "Connect a WhatsApp number", section: "whatsapp", tab: "numbers", access: "all" },
  { label: "Check the email mailbox", section: "email", tab: "connection", access: "admin" },
  {
    label: "Set my booking link",
    section: "profile",
    anchor: "profile-booking-url",
    access: "all",
  },
];
