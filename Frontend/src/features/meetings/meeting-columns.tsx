import { Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DataTableColumn } from "@/components/crm/data-table";
import { RelativeTime } from "@/components/crm/relative-time";
import { StatusPill } from "@/components/crm/status-pill";
import { UserAvatar } from "@/components/crm/user-avatar";
import { RefLink } from "@/features/work/ref-link";
import { label } from "@/lib/labels";
import type { MeetingListItem } from "@/types";
import { MEETING_STATUS_TONE, joinLink } from "./meeting-labels";
import { CalendarSyncIcon, NotifyIcons } from "./meeting-status-icons";

const dash = <span className="text-muted-foreground">–</span>;

/** Meeting table columns; ids are the saved-view column ids, `sortable` only on the API whitelist. */
export const MEETING_COLUMNS: DataTableColumn<MeetingListItem>[] = [
  {
    id: "title",
    header: "Title",
    hideable: false,
    size: 240,
    cell: (m) => <span className="truncate font-medium">{m.title}</span>,
  },
  {
    id: "at",
    header: "When",
    sortable: true,
    size: 190,
    cell: (m) => <RelativeTime value={m.at} />,
  },
  { id: "contact", header: "Contact", cell: (m) => <RefLink type="contact" value={m.contact} /> },
  { id: "company", header: "Company", cell: (m) => <RefLink type="company" value={m.company} /> },
  { id: "deal", header: "Deal", cell: (m) => <RefLink type="deal" value={m.deal} /> },
  {
    id: "owner",
    header: "Owner",
    cell: (m) => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <UserAvatar name={m.ownerName} size="sm" />
        <span className="truncate">{m.ownerName ?? "No owner"}</span>
      </span>
    ),
  },
  {
    id: "status",
    header: "Status",
    size: 130,
    cell: (m) => <StatusPill tone={MEETING_STATUS_TONE[m.status]}>{label(m.status)}</StatusPill>,
  },
  { id: "outcome", header: "Outcome", cell: (m) => (m.outcome ? label(m.outcome) : dash) },
  { id: "calendar", header: "Calendar", size: 100, cell: (m) => <CalendarSyncIcon meeting={m} /> },
  { id: "notify", header: "Notify", size: 100, cell: (m) => <NotifyIcons meeting={m} /> },
  {
    id: "link",
    header: "Link",
    size: 100,
    cell: (m) => {
      const href = joinLink(m);
      return href ? (
        <Button asChild size="sm" variant="outline" className="h-7">
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`Join ${m.title}`}
            onClick={(e) => e.stopPropagation()}
          >
            <Video /> Join
          </a>
        </Button>
      ) : (
        dash
      );
    },
  },
  {
    id: "createdAt",
    header: "Created",
    sortable: true,
    cell: (m) => <RelativeTime value={m.createdAt} />,
  },
];
