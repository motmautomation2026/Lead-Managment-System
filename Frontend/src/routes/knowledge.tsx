import { createFileRoute } from "@tanstack/react-router";
import { KnowledgePage } from "@/features/knowledge/knowledge-page";

export const Route = createFileRoute("/knowledge")({
  head: () => ({ meta: [{ title: "Knowledge - MOTM Flow" }] }),
  component: KnowledgePage,
});
