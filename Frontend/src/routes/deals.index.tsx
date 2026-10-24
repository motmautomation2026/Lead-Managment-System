import { createFileRoute } from "@tanstack/react-router";
import { Handshake } from "lucide-react";
import { ComingSoonPage } from "@/features/crm/coming-soon-page";

export const Route = createFileRoute("/deals/")({
  head: () => ({ meta: [{ title: "Deals - MOTM Flow" }] }),
  component: () => (
    <ComingSoonPage
      title="Deals"
      icon={Handshake}
      text="Deals as a table and a stage board, with amounts and expected close dates."
    />
  ),
});
