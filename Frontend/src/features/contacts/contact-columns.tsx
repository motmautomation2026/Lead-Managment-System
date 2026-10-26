import { StatusBadge } from "@/components/common/status-badge";
import type { DataTableColumn } from "@/components/crm/data-table";
import { UserAvatar } from "@/components/crm/user-avatar";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";
import { AGENT_STATUS_LABEL, AGENT_STATUS_TONE } from "@/features/agent/agent-labels";
import { isOverdue } from "@/lib/format";
import { label } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { ContactListItem } from "@/types";
import { RecordLink } from "@/features/crm/record-link";

const dash = <span className="text-muted-foreground">–</span>;

/** Contacts table columns (`id` = B4 column id); the Contacts list and a company's Contacts tab. */
export const CONTACT_COLUMNS: DataTableColumn<ContactListItem>[] = [
  {
    id: "name",
    header: "Name",
    sortable: true,
    hideable: false,
    size: 220,
    cell: (r) => (
      <span className="inline-flex min-w-0 items-center gap-2 font-medium">
        <UserAvatar name={r.name} size="sm" />
        <span className="truncate">{r.name}</span>
      </span>
    ),
  },
  {
    id: "company",
    header: "Company",
    sortable: true,
    cell: (r) =>
      r.company ? (
        <RecordLink
          type="company"
          id={r.company.id}
          // Not the row's own link: open the company, not the contact.
          onClick={(e) => e.stopPropagation()}
          className="truncate hover:underline"
        >
          {r.company.name}
        </RecordLink>
      ) : (
        dash
      ),
  },
  { id: "email", header: "Email", size: 220, cell: (r) => r.email || dash },
  { id: "phone", header: "Phone", size: 150, cell: (r) => r.phone || dash },
  {
    id: "owner",
    header: "Owner",
    cell: (r) => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <UserAvatar name={r.owner?.name} size="sm" />
        <span className="truncate">{r.owner?.name ?? "Unassigned"}</span>
      </span>
    ),
  },
  {
    id: "leadStatus",
    header: "Lead status",
    cell: (r) => <StatusBadge value={r.leadStatus} />,
  },
  {
    id: "openDeal",
    header: "Open deal",
    size: 200,
    cell: (r) =>
      r.openDeal ? (
        <span className="inline-flex items-center gap-2">
          <StatusBadge value={r.openDeal.stage} />
          <Money amount={r.openDeal.amount} currency={r.openDeal.currency} compact />
        </span>
      ) : (
        dash
      ),
  },
  {
    id: "nextAction",
    header: "Next action",
    size: 200,
    cell: (r) =>
      r.nextAction ? (
        <div className="min-w-0">
          <div className="truncate">{r.nextAction.title}</div>
          <RelativeTime
            value={r.nextAction.dueAt}
            className={cn(
              "type-small",
              isOverdue(r.nextAction.dueAt) ? "text-destructive" : "text-muted-foreground",
            )}
          />
        </div>
      ) : (
        dash
      ),
  },
  {
    id: "lastActivityAt",
    header: "Last activity",
    sortable: true,
    cell: (r) => <RelativeTime value={r.lastActivityAt} />,
  },
  {
    id: "agentStatus",
    header: "AI status",
    size: 120,
    cell: (r) =>
      r.agentStatus === "none" ? (
        dash
      ) : (
        <StatusBadge
          value={r.agentStatus}
          display={AGENT_STATUS_LABEL[r.agentStatus]}
          tone={AGENT_STATUS_TONE[r.agentStatus]}
        />
      ),
  },
  { id: "source", header: "Source", size: 130, cell: (r) => label(r.source) },
  { id: "jobTitle", header: "Job title", cell: (r) => r.jobTitle || dash },
  {
    id: "lifecycle",
    header: "Lifecycle",
    size: 140,
    cell: (r) => <StatusBadge value={r.lifecycle} />,
  },
  {
    id: "createdAt",
    header: "Created",
    sortable: true,
    cell: (r) => <RelativeTime value={r.createdAt} />,
  },
];
