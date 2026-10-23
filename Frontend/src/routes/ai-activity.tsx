import { createFileRoute } from "@tanstack/react-router";
import { AiActivityPage } from "@/features/agent/ai-activity-page";

export const Route = createFileRoute("/ai-activity")({
  head: () => ({ meta: [{ title: "AI Activity - MOTM Flow" }] }),
  component: AiActivityPage,
});
