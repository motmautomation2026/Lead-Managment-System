import { createFileRoute } from "@tanstack/react-router";
import { CallQueuePage } from "@/features/tasks/call-queue";

export const Route = createFileRoute("/tasks_/calls")({
  head: () => ({ meta: [{ title: "Call queue - MOTM Flow" }] }),
  component: CallQueuePage,
});
