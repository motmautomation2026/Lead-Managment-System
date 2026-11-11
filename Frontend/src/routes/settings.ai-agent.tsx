import { createFileRoute } from "@tanstack/react-router";
import { AgentModeSection } from "@/features/settings/agent-panel";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/ai-agent")({
  head: settingsHead("AI agent"),
  component: AgentModeSection,
});
