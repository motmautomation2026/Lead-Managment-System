import { Navigate, useSearch } from "@tanstack/react-router";
import { adminRedirectSearch, validateAdminSearch } from "./settings-search";

/**
 * /admin moved into Settings (C6b). AuthGate still shows the admin sign-in at /admin; once
 * signed in, Users opens — or, for the Google Calendar OAuth landing (A5), the Workspace tab
 * with the same `calendar` / `message` query so its toast still shows.
 */
export function AdminRedirect() {
  const search = validateAdminSearch(useSearch({ strict: false }));
  return <Navigate to="/settings" search={adminRedirectSearch(search)} replace />;
}
