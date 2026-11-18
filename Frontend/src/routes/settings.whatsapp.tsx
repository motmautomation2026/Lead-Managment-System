import { createFileRoute } from "@tanstack/react-router";
import { WhatsAppSection } from "@/features/settings/whatsapp-section";
import { settingsHead, validateWhatsAppSearch } from "@/features/settings/settings-search";

export const Route = createFileRoute("/settings/whatsapp")({
  head: settingsHead("WhatsApp"),
  validateSearch: validateWhatsAppSearch,
  component: WhatsAppSection,
});
