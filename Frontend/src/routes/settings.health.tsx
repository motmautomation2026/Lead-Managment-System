import { createFileRoute } from "@tanstack/react-router";
import { HealthSection } from "@/features/settings/system-health-panel";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/health")({
  head: settingsHead("System health"),
  component: HealthSection,
});
