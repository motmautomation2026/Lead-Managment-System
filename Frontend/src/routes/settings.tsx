import { createFileRoute } from "@tanstack/react-router";
import { SettingsLayout } from "@/features/settings/settings-layout";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings - MOTM Flow" },
      {
        name: "description",
        content: "Workspace, channels, AI agent, personal and admin settings.",
      },
    ],
  }),
  component: SettingsLayout,
});
