import { createFileRoute } from "@tanstack/react-router";
import { ReplyQueuePage } from "@/features/tasks/reply-queue";

export const Route = createFileRoute("/tasks_/replies")({
  head: () => ({ meta: [{ title: "Replies - MOTM Flow" }] }),
  component: ReplyQueuePage,
});
