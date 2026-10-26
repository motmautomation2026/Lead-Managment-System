import { createFileRoute, redirect } from "@tanstack/react-router";

// The old lead page moved to /contacts/$id (C2; its code was removed in C6b).
export const Route = createFileRoute("/leads/$leadId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/contacts/$contactId",
      params: { contactId: params.leadId },
      replace: true,
    });
  },
});
