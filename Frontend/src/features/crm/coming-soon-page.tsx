import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/crm/page-header";
import { EmptyState } from "@/components/crm/empty-state";

/** Placeholder for CRM pages that land in later C phases (no data calls). */
export function ComingSoonPage({
  title,
  icon,
  text,
}: {
  title: string;
  icon: LucideIcon;
  text: string;
}) {
  return (
    <div>
      <PageHeader title={title} />
      <EmptyState icon={icon} title="Coming in the next update" text={text} />
    </div>
  );
}
