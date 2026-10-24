import { createFileRoute } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { ComingSoonPage } from "@/features/crm/coming-soon-page";

export const Route = createFileRoute("/companies/")({
  head: () => ({ meta: [{ title: "Companies - MOTM Flow" }] }),
  component: () => (
    <ComingSoonPage
      title="Companies"
      icon={Building2}
      text="Every company with its contacts, open deals and owner will live here."
    />
  ),
});
