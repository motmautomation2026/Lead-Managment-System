import { EmptyState } from "@/components/crm/empty-state";
import type { DealListParams } from "@/types";

/** Pipeline board (Item 4 of C4 replaces this placeholder). */
export function DealBoard(_props: {
  params: DealListParams;
  showClosed: boolean;
  onShowClosedChange: (on: boolean) => void;
}) {
  return <EmptyState title="Board" text="The pipeline board is coming next." />;
}
