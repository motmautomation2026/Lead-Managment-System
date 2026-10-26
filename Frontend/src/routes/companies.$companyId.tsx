import { createFileRoute } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { ComingSoonPage } from "@/features/crm/coming-soon-page";

export const Route = createFileRoute("/companies/$companyId")({
  head: () => ({ meta: [{ title: "Company - MOTM Flow" }] }),
  component: () => (
    <ComingSoonPage title="Company" icon={Building2} text="The company record page." />
  ),
});
