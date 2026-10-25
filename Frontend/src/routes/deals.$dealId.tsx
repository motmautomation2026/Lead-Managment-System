import { createFileRoute } from "@tanstack/react-router";
import { Handshake } from "lucide-react";
import { ComingSoonPage } from "@/features/crm/coming-soon-page";

// Placeholder until the deal record page (C4); contact records already link here.
export const Route = createFileRoute("/deals/$dealId")({
  head: () => ({ meta: [{ title: "Deal - MOTM Flow" }] }),
  component: () => (
    <ComingSoonPage
      title="Deal"
      icon={Handshake}
      text="The deal record (stage, amount, meetings and proposals) comes with the Deals update."
    />
  ),
});
