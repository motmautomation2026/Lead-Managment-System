import { createFileRoute } from "@tanstack/react-router";
import { SettingsIndex } from "@/features/settings/settings-index";
import { validateSettingsIndexSearch } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/")({
  validateSearch: validateSettingsIndexSearch,
  component: SettingsIndex,
});
