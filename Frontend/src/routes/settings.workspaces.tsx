import { createFileRoute } from "@tanstack/react-router";
import { WorkspacesSection } from "@/features/settings/super-admin-panel";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/workspaces")({
  head: settingsHead("All workspaces"),
  component: WorkspacesSection,
});
