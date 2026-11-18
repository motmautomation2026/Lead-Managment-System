import { createFileRoute } from "@tanstack/react-router";
import { PlaybookSection } from "@/features/settings/playbook-section";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/playbook")({
  head: settingsHead("Playbook"),
  component: PlaybookSection,
});
