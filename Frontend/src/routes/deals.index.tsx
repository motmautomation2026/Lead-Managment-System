import { createFileRoute } from "@tanstack/react-router";
import { DealsPage } from "@/features/deals/deals-page";
import { validateDealsSearch } from "@/features/deals/deals-search";

export const Route = createFileRoute("/deals/")({
  head: () => ({ meta: [{ title: "Deals - MOTM Flow" }] }),
  validateSearch: validateDealsSearch,
  component: DealsPage,
});
