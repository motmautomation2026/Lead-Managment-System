import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/features/settings/settings-page";
import { validateSettingsSearch } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings - MOTM Flow" },
      {
        name: "description",
        content:
          "Workspace connections, lead assignment, the AI agent, users and appearance settings.",
      },
      { property: "og:title", content: "Settings - MOTM Flow" },
      {
        property: "og:description",
        content: "Configure how this workspace sends email, WhatsApp, and calendar invites.",
      },
    ],
  }),
  validateSearch: validateSettingsSearch,
  component: SettingsPage,
});
