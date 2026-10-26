import { createFileRoute } from "@tanstack/react-router";
import { CompanyRecordPage } from "@/features/companies/company-record-page";

export const Route = createFileRoute("/companies/$companyId")({
  head: () => ({ meta: [{ title: "Company - MOTM Flow" }] }),
  component: CompanyRoute,
});

function CompanyRoute() {
  const { companyId } = Route.useParams();
  return <CompanyRecordPage companyId={companyId} />;
}
