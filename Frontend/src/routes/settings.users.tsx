import { createFileRoute } from "@tanstack/react-router";
import { UsersSection } from "@/features/settings/users-panel";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/users")({
  head: settingsHead("User accounts"),
  component: UsersSection,
});
