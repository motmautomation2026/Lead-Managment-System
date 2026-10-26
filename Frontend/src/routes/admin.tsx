import { createFileRoute } from "@tanstack/react-router";
import { AdminRedirect } from "@/features/settings/admin-redirect";
import { validateAdminSearch } from "@/features/settings/settings-search";

export const Route = createFileRoute("/admin")({
  validateSearch: validateAdminSearch,
  component: AdminRedirect,
});
