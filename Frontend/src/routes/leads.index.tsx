import { createFileRoute, redirect } from "@tanstack/react-router";
import { validateContactsSearch } from "@/features/contacts/contacts-search";

// The old leads list (features/leads/leads-page.tsx, unrouted until C6) moved to /contacts.
// Old param names map onto the contacts list params; the rest is validated as contacts params.
export const Route = createFileRoute("/leads/")({
  beforeLoad: ({ search }) => {
    const { search: q, stage, ...rest } = search as Record<string, unknown>;
    const asList = (v: unknown) => (typeof v === "string" ? [v] : v);
    throw redirect({
      to: "/contacts",
      search: validateContactsSearch({
        ...rest,
        ...(typeof q === "string" ? { q } : {}),
        ...(stage !== undefined ? { leadStatus: asList(stage) } : {}),
        ...(rest["ownerId"] !== undefined ? { ownerId: asList(rest["ownerId"]) } : {}),
        ...(rest["lifecycle"] !== undefined ? { lifecycle: asList(rest["lifecycle"]) } : {}),
        ...(rest["source"] !== undefined ? { source: asList(rest["source"]) } : {}),
      }),
      replace: true,
    });
  },
});
