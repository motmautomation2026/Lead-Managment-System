import { createFileRoute } from "@tanstack/react-router";
import { CopyCheck } from "lucide-react";
import { ComingSoonPage } from "@/features/crm/coming-soon-page";

export const Route = createFileRoute("/companies/duplicates")({
  head: () => ({ meta: [{ title: "Duplicate companies - MOTM Flow" }] }),
  component: () => (
    <ComingSoonPage title="Duplicate companies" icon={CopyCheck} text="Duplicate review." />
  ),
});
