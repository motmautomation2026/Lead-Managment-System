import { createFileRoute } from "@tanstack/react-router";
import { AiActivityPage } from "@/features/agent/ai-activity-page";
import { validateAiActivitySearch } from "@/features/agent/ai-activity-search";

export const Route = createFileRoute("/ai-activity")({
  head: () => ({ meta: [{ title: "AI Activity - MOTM Flow" }] }),
  validateSearch: validateAiActivitySearch,
  component: AiActivityPage,
});
