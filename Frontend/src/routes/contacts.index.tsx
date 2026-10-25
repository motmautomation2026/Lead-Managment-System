import { createFileRoute } from "@tanstack/react-router";
import { ContactsPage } from "@/features/contacts/contacts-page";
import { validateContactsSearch } from "@/features/contacts/contacts-search";

export const Route = createFileRoute("/contacts/")({
  head: () => ({ meta: [{ title: "Contacts - MOTM Flow" }] }),
  validateSearch: validateContactsSearch,
  component: ContactsPage,
});
