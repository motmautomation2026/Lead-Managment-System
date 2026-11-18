import { createFileRoute } from "@tanstack/react-router";
import { EmailSection } from "@/features/settings/email-settings";
import { settingsHead, validateEmailSearch } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/email")({
  head: settingsHead("Email"),
  validateSearch: validateEmailSearch,
  component: EmailSection,
});
