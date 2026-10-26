import { Link } from "@tanstack/react-router";
import type { DataTableColumn } from "@/components/crm/data-table";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";
import { UserAvatar } from "@/components/crm/user-avatar";
import { fmtDate } from "@/lib/format";
import type { DealListItem } from "@/types";
import { DealStagePill } from "./deal-stage-pill";

const dash = <span className="text-muted-foreground">–</span>;

/** "2026-11-30" (a calendar date) shown as an IST date. */
export const closeDate = (date: string | null) => (date ? fmtDate(`${date}T12:00:00+05:30`) : null);

/** Deal table columns; ids are the B4 column ids, `sortable` only on the B4 sort whitelist. */
export const DEAL_COLUMNS: DataTableColumn<DealListItem>[] = [
  {
    id: "name",
    header: "Name",
    sortable: true,
    hideable: false,
    size: 240,
    cell: (d) => <span className="truncate font-medium">{d.name}</span>,
  },
  { id: "stage", header: "Stage", size: 180, cell: (d) => <DealStagePill stage={d.stage} /> },
  {
    id: "amount",
    header: "Amount",
    sortable: true,
    size: 130,
    cell: (d) => (d.amount === null ? dash : <Money amount={d.amount} currency={d.currency} />),
  },
  {
    id: "expectedCloseDate",
    header: "Expected close",
    sortable: true,
    size: 140,
    cell: (d) => closeDate(d.expectedCloseDate) ?? dash,
  },
  {
    id: "owner",
    header: "Owner",
    cell: (d) => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <UserAvatar name={d.owner?.name} size="sm" />
        <span className="truncate">{d.owner?.name ?? "No owner"}</span>
      </span>
    ),
  },
  {
    id: "company",
    header: "Company",
    cell: (d) =>
      d.company ? (
        <Link
          to="/companies/$companyId"
          params={{ companyId: d.company.id }}
          className="truncate hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {d.company.name}
        </Link>
      ) : (
        dash
      ),
  },
  {
    id: "contact",
    header: "Contact",
    cell: (d) => (
      <Link
        to="/contacts/$contactId"
        params={{ contactId: d.contact.id }}
        className="truncate hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {d.contact.name || "Unnamed contact"}
      </Link>
    ),
  },
  {
    id: "source",
    header: "Source",
    size: 110,
    cell: (d) => <span className="capitalize">{d.source}</span>,
  },
  {
    id: "closedAt",
    header: "Closed",
    cell: (d) => (d.closedAt ? <RelativeTime value={d.closedAt} /> : dash),
  },
  {
    id: "createdAt",
    header: "Created",
    sortable: true,
    cell: (d) => <RelativeTime value={d.createdAt} />,
  },
  {
    id: "updatedAt",
    header: "Updated",
    sortable: true,
    cell: (d) => <RelativeTime value={d.updatedAt} />,
  },
];
