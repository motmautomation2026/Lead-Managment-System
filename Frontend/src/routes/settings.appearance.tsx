import { createFileRoute } from "@tanstack/react-router";
import { AppearanceSection } from "@/features/settings/appearance-panel";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/appearance")({
  head: settingsHead("Appearance"),
  component: AppearanceSection,
});
