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
  const navigate = Route.useNavigate();
  // Picking a tab drops the deep link, so following the same link again works.
  return (
    <ContactRecordPage
      contactId={contactId}
      link={link}
      onTabChange={() => {
        if (link.tab) void navigate({ search: {}, replace: true });
      }}
    />
  );
}
