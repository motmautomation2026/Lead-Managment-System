import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/features/home/home-page";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Home - MOTM Flow" },
      {
        name: "description",
        content:
          "Your day: overdue and due tasks, today's meetings, your pipeline, proposals awaiting a decision and AI drafts to review.",
      },
      { property: "og:title", content: "Home - MOTM Flow" },
      {
        property: "og:description",
        content: "Lead management and sales automation at a glance.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HomePage,
});
