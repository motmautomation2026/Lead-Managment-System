import { createFileRoute } from "@tanstack/react-router";
import { SearchPage } from "@/features/search/search-page";
import { validateSearchPage } from "@/features/search/search-schema";

export const Route = createFileRoute("/search")({
  head: () => ({ meta: [{ title: "Search - MOTM Flow" }] }),
  validateSearch: validateSearchPage,
  component: SearchPage,
});
