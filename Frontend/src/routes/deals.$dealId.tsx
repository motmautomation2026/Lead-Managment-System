import { createFileRoute } from "@tanstack/react-router";
import { DealRecordPage } from "@/features/deals/deal-record-page";

export const Route = createFileRoute("/deals/$dealId")({
  head: () => ({ meta: [{ title: "Deal - MOTM Flow" }] }),
  component: DealRoute,
});

function DealRoute() {
  const { dealId } = Route.useParams();
  return <DealRecordPage dealId={dealId} />;
}
