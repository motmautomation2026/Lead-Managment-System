import { createFileRoute } from "@tanstack/react-router";
import { TasksPage } from "@/features/tasks/tasks-page";
import { validateTasksSearch } from "@/features/tasks/tasks-search";

export const Route = createFileRoute("/tasks")({
  head: () => ({
    meta: [
      { title: "Tasks - MOTM Flow" },
      {
        name: "description",
        content: "Every call, follow-up and reminder due for the sales team, grouped by urgency.",
      },
      { property: "og:title", content: "Tasks - MOTM Flow" },
      {
        property: "og:description",
        content: "Today, overdue and upcoming sales tasks in one queue.",
      },
    ],
  }),
  validateSearch: validateTasksSearch,
  component: TasksPage,
});
