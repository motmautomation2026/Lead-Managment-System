import { Navigate, useSearch } from "@tanstack/react-router";
import { useMediaQuery } from "@/lib/use-media-query";
import {
  DEFAULT_SETTINGS_SECTION,
  legacySettingsRedirect,
  settingsPath,
  validateSettingsIndexSearch,
} from "./settings-search";

/**
 * `/settings`: old `?tab=…` links (and the Calendar OAuth result) go to their section; on desktop the default
 * section opens; on phones the layout shows the section list (this renders nothing).
 */
export function SettingsIndex() {
  const search = validateSettingsIndexSearch(useSearch({ strict: false }));
  const desktop = useMediaQuery("(min-width: 1024px)");
  const legacy = legacySettingsRedirect(search);
  if (legacy)
    return <Navigate to={settingsPath(legacy.section)} search={legacy.search as never} replace />;
  if (desktop) return <Navigate to={settingsPath(DEFAULT_SETTINGS_SECTION)} replace />;
  return null;
}
