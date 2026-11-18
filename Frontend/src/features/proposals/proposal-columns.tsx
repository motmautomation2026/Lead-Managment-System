import { FileText } from "lucide-react";
import type { DataTableColumn } from "@/components/crm/data-table";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";
import { StatusPill } from "@/components/crm/status-pill";
import { UserAvatar } from "@/components/crm/user-avatar";
import { RefLink } from "@/features/work/ref-link";
import { label } from "@/lib/labels";
import type { ProposalListItem } from "@/types";
import { ProposalSendIcons } from "./proposal-send-icons";
import { PROPOSAL_STATUS_TONE } from "./proposals-search";

const dash = <span className="text-muted-foreground">–</span>;

/** Proposal table columns; ids are the saved-view column ids, `sortable` only on the API whitelist. */
export const PROPOSAL_COLUMNS: DataTableColumn<ProposalListItem>[] = [
  {
    id: "title",
    header: "Title",
    hideable: false,
    size: 240,
    cell: (p) => <span className="truncate font-medium">{p.title}</span>,
  },
  { id: "contact", header: "Contact", cell: (p) => <RefLink type="contact" value={p.contact} /> },
  { id: "company", header: "Company", cell: (p) => <RefLink type="company" value={p.company} /> },
  { id: "deal", header: "Deal", cell: (p) => <RefLink type="deal" value={p.deal} /> },
  {
    id: "amount",
    header: "Amount",
    sortable: true,
    size: 130,
    cell: (p) =>
      p.amount === undefined ? dash : <Money amount={p.amount} currency={p.currency} />,
  },
  {
    id: "status",
    header: "Status",
    size: 150,
    cell: (p) => <StatusPill tone={PROPOSAL_STATUS_TONE[p.status]}>{label(p.status)}</StatusPill>,
  },
  {
    id: "sentAt",
    header: "Sent",
    sortable: true,
    cell: (p) => (p.sentDate ? <RelativeTime value={p.sentDate} /> : dash),
  },
  {
    id: "owner",
    header: "Owner",
    cell: (p) => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <UserAvatar name={p.ownerName} size="sm" />
        <span className="truncate">{p.ownerName ?? "No owner"}</span>
      </span>
    ),
  },
  {
    id: "updatedAt",
    header: "Updated",
    sortable: true,
    cell: (p) => <RelativeTime value={p.updatedAt} />,
  },
  {
    id: "sendStatus",
    header: "Sent via",
    size: 160,
    cell: (p) => <ProposalSendIcons proposal={p} />,
  },
  {
    id: "document",
    header: "Document",
    cell: (p) =>
      p.fileName ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{p.fileName}</span>
        </span>
      ) : (
        dash
      ),
  },
];
