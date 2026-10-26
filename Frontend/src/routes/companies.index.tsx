import { createFileRoute } from "@tanstack/react-router";
import { CompaniesPage } from "@/features/companies/companies-page";
import { validateCompaniesSearch } from "@/features/companies/companies-search";

export const Route = createFileRoute("/companies/")({
  head: () => ({ meta: [{ title: "Companies - MOTM Flow" }] }),
  validateSearch: validateCompaniesSearch,
  component: CompaniesPage,
});
