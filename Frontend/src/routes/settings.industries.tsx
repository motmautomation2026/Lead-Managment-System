import { createFileRoute } from "@tanstack/react-router";
import { IndustriesSection } from "@/features/settings/agent-panel";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/industries")({
  head: settingsHead("Target industries"),
  component: IndustriesSection,
});
