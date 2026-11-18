import type { DataTableColumn } from "@/components/crm/data-table";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";
import { UserAvatar } from "@/components/crm/user-avatar";
import type { CompanyListItem } from "@/types";

const dash = <span className="text-muted-foreground">–</span>;

/** Company table columns; ids are the B4 column ids, `sortable` only on the B4 sort whitelist. */
export const COMPANY_COLUMNS: DataTableColumn<CompanyListItem>[] = [
  {
    id: "name",
    header: "Name",
    sortable: true,
    hideable: false,
    size: 240,
    cell: (r) => (
      <span className="inline-flex min-w-0 items-center gap-2 font-medium">
        <UserAvatar name={r.name} size="sm" className="rounded-md" />
        <span className="truncate">{r.name}</span>
      </span>
    ),
  },
  { id: "domain", header: "Domain", size: 180, cell: (r) => r.domain || dash },
  { id: "industry", header: "Industry", cell: (r) => r.industry || dash },
  { id: "city", header: "City", size: 130, cell: (r) => r.city || dash },
  {
    id: "owner",
    header: "Owner",
    cell: (r) => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <UserAvatar name={r.owner?.name} size="sm" />
        <span className="truncate">{r.owner?.name ?? "No owner"}</span>
      </span>
    ),
  },
  {
    id: "contactCount",
    header: "Contacts",
    sortable: true,
    size: 110,
    cell: (r) => <span className="num">{r.contactCount}</span>,
  },
  {
    id: "openDealCount",
    header: "Open deals",
    size: 160,
    cell: (r) =>
      r.openDealCount ? (
        <span className="inline-flex items-center gap-2">
          <span className="num">{r.openDealCount}</span>
          <Money amount={r.openDealAmount} compact className="text-muted-foreground" />
        </span>
      ) : (
        dash
      ),
  },
  {
    id: "createdAt",
    header: "Created",
    sortable: true,
    cell: (r) => <RelativeTime value={r.createdAt} />,
  },
  {
    id: "updatedAt",
    header: "Updated",
    sortable: true,
    cell: (r) => <RelativeTime value={r.updatedAt} />,
  },
];
