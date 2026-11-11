import { createFileRoute } from "@tanstack/react-router";
import { MessageRulesSection } from "@/features/settings/agent-panel";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/message-rules")({
  head: settingsHead("Message rules"),
  component: MessageRulesSection,
});
