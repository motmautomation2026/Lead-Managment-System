import { createFileRoute } from "@tanstack/react-router";
import { ProfileSection } from "@/features/settings/profile-panel";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/profile")({
  head: settingsHead("My profile"),
  component: ProfileSection,
});
