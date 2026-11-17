import { createFileRoute } from "@tanstack/react-router";
import { ContactRecordPage } from "@/features/contacts/contact-record-page";
import { validateContactRecordSearch } from "@/features/contacts/contact-helpers";

export const Route = createFileRoute("/contacts/$contactId")({
  head: () => ({ meta: [{ title: "Contact - MOTM Flow" }] }),
  validateSearch: validateContactRecordSearch,
  component: ContactRoute,
});

function ContactRoute() {
  const { contactId } = Route.useParams();
  const link = Route.useSearch();
  return <ContactRecordPage contactId={contactId} link={link} />;
}
