import { createFileRoute } from "@tanstack/react-router";
import { TeamSection } from "@/features/settings/team-panel";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/team")({
  head: settingsHead("Team"),
  component: TeamSection,
});
