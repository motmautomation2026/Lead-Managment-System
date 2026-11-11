import { createFileRoute } from "@tanstack/react-router";
import { AgentLimitsSection } from "@/features/settings/ai-limits-section";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/ai-limits")({
  head: settingsHead("Limits & schedule"),
  component: AgentLimitsSection,
});
