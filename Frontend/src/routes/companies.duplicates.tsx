import { createFileRoute } from "@tanstack/react-router";
import { DuplicatesPage } from "@/features/companies/duplicates-page";
import { validateDuplicatesSearch } from "@/features/companies/duplicates-search";

export const Route = createFileRoute("/companies/duplicates")({
  head: () => ({ meta: [{ title: "Duplicate companies - MOTM Flow" }] }),
  validateSearch: validateDuplicatesSearch,
  component: DuplicatesPage,
});
