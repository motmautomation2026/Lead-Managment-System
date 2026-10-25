import { createFileRoute } from "@tanstack/react-router";
import { LeadDetailPage } from "@/features/leads/lead-detail-page";

export const Route = createFileRoute("/contacts/$contactId")({
  head: () => ({ meta: [{ title: "Contact - MOTM Flow" }] }),
  component: ContactRoute,
});

function ContactRoute() {
  const { contactId } = Route.useParams();
  return <LeadDetailPage leadId={contactId} />;
}
