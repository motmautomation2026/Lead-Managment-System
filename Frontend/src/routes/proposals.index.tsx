import { createFileRoute } from "@tanstack/react-router";
import { ProposalsPage } from "@/features/proposals/proposals-page";
import { validateProposalsSearch } from "@/features/proposals/proposals-search";

export const Route = createFileRoute("/proposals/")({
  head: () => ({
    meta: [
      { title: "Proposals - MOTM Flow" },
      {
        name: "description",
        content: "Upload proposals, track what was sent and record the accept or reject decision.",
      },
      { property: "og:title", content: "Proposals - MOTM Flow" },
      { property: "og:description", content: "Simple proposal tracking with follow-up dates." },
    ],
  }),
  validateSearch: validateProposalsSearch,
  component: ProposalsPage,
});
