import { z } from "zod";

/**
 * Settings sections (`/settings?tab=…`). `access`: everyone; `admin` of THIS workspace (E4b); `users` = user
 * accounts (/admin: global admin or super-admin); `super` = super-admins only.
 */
export const SETTINGS_TABS = [
  { id: "workspace", label: "Workspace", access: "all" },
  { id: "assignment", label: "Lead assignment", access: "admin" },
  // E2b: everyone sees the message rules (read-only); the rest of the tab is admin-only.
  { id: "agent", label: "AI agent", access: "all" },
  // E4b rule 9: this workspace's members.
  { id: "team", label: "Team", access: "admin" },
  { id: "users", label: "Users", access: "users" },
  // E4b rule 10: every workspace × user.
  { id: "workspaces", label: "All workspaces", access: "super" },
  // E3b-1: everyone's own booking link.
  { id: "profile", label: "Profile", access: "all" },
  { id: "appearance", label: "Appearance", access: "all" },
] as const;
export type SettingsAccess = (typeof SETTINGS_TABS)[number]["access"];
export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/**
 * `calendar` / `message` are the Google Calendar OAuth result (A5: the backend redirects to
 * `/admin?calendar=…`); the Calendar panel shows the toast and strips them.
 */
export const settingsSearchSchema = z.object({
  tab: z
    .enum([
      "workspace",
      "assignment",
      "agent",
      "team",
      "users",
      "workspaces",
      "profile",
      "appearance",
    ])
    .optional(),
  calendar: z.string().optional(),
  message: z.string().optional(),
});
export type SettingsSearch = z.infer<typeof settingsSearchSchema>;

export const validateSettingsSearch = (search: Record<string, unknown>): SettingsSearch => {
  const parsed = settingsSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};

export const adminSearchSchema = z.object({
  calendar: z.string().optional(),
  message: z.string().optional(),
});
export const validateAdminSearch = (search: Record<string, unknown>) => {
  const parsed = adminSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};

/** Where `/admin` goes: the Calendar OAuth landing keeps its query on the Workspace tab; else Users. */
export function adminRedirectSearch(search: z.infer<typeof adminSearchSchema>): SettingsSearch {
  return search.calendar
    ? { tab: "workspace", calendar: search.calendar, message: search.message }
    : { tab: "users" };
}
