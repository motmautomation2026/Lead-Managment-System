import { createFileRoute } from "@tanstack/react-router";
import { StyleSection } from "@/features/settings/style-examples-card";
import { settingsHead } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/style")({
  head: settingsHead("Style examples"),
  component: StyleSection,
});
