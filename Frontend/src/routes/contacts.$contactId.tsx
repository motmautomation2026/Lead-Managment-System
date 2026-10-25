import { createFileRoute } from "@tanstack/react-router";
import { ContactRecordPage } from "@/features/contacts/contact-record-page";

export const Route = createFileRoute("/contacts/$contactId")({
  head: () => ({ meta: [{ title: "Contact - MOTM Flow" }] }),
  component: ContactRoute,
});

function ContactRoute() {
  const { contactId } = Route.useParams();
  return <ContactRecordPage contactId={contactId} />;
}
