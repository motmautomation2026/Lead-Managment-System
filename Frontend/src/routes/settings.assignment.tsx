import { createFileRoute } from "@tanstack/react-router";
import { AssignmentSection } from "@/features/settings/lead-assignment-panel";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/assignment")({
  head: settingsHead("Lead assignment"),
  component: AssignmentSection,
});
