import { Navigate, useSearch } from "@tanstack/react-router";
import { adminRedirect, settingsPath, validateAdminSearch } from "./settings-search";

/**
 * /admin moved into Settings (C6b). AuthGate still shows the admin sign-in at /admin; once signed in, User accounts
 * opens — or, for the Google Calendar OAuth landing (A5), Settings → Google Calendar with the same `calendar` /
 * `message` query so its toast still shows.
 */
export function AdminRedirect() {
  const to = adminRedirect(validateAdminSearch(useSearch({ strict: false })));
  return <Navigate to={settingsPath(to.section)} search={to.search as never} replace />;
}
