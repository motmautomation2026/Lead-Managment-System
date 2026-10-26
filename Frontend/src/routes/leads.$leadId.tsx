import { createFileRoute, redirect } from "@tanstack/react-router";

// The old lead page (features/leads/lead-detail-page.tsx, unrouted until C6) moved to /contacts/$id.
export const Route = createFileRoute("/leads/$leadId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/contacts/$contactId",
      params: { contactId: params.leadId },
      replace: true,
    });
  },
});
