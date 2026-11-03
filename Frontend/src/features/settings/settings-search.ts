import { z } from "zod";

/** Settings sections (`/settings?tab=…`); `admin` ones are shown to admins only. */
export const SETTINGS_TABS = [
  { id: "workspace", label: "Workspace", admin: false },
  { id: "assignment", label: "Lead assignment", admin: true },
  // E2b: everyone sees the message rules (read-only); the rest of the tab is admin-only.
  { id: "agent", label: "AI agent", admin: false },
  { id: "users", label: "Users", admin: true },
  // E3b-1: everyone's own booking link.
  { id: "profile", label: "Profile", admin: false },
  { id: "appearance", label: "Appearance", admin: false },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/**
 * `calendar` / `message` are the Google Calendar OAuth result (A5: the backend redirects to
 * `/admin?calendar=…`); the Calendar panel shows the toast and strips them.
 */
export const settingsSearchSchema = z.object({
  tab: z.enum(["workspace", "assignment", "agent", "users", "profile", "appearance"]).optional(),
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
