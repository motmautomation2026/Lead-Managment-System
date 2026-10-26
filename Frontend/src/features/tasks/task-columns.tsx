import type { DataTableColumn } from "@/components/crm/data-table";
import { RelativeTime } from "@/components/crm/relative-time";
import { StatusPill, type PillTone } from "@/components/crm/status-pill";
import { UserAvatar } from "@/components/crm/user-avatar";
import { TaskOriginBadge } from "@/components/common/status-badge";
import { RefLink } from "@/features/work/ref-link";
import { DoneToggle } from "./done-toggle";
import { label } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { TaskListItem } from "@/types";

export const TASK_STATUS_TONE: Record<TaskListItem["status"], PillTone> = {
  open: "info",
  completed: "success",
  cancelled: "neutral",
};

/** Task table columns; ids are the saved-view column ids, `sortable` only on the API whitelist. */
export function taskColumns(onDone: (task: TaskListItem) => void): DataTableColumn<TaskListItem>[] {
  return [
    {
      id: "title",
      header: "Title",
      hideable: false,
      size: 280,
      cell: (t) => (
        <span className="inline-flex min-w-0 items-center gap-2.5">
          <DoneToggle task={t} onDone={onDone} />
          <span
            className={cn(
              "truncate font-medium",
              t.status !== "open" && "text-muted-foreground line-through",
            )}
          >
            {t.title}
          </span>
        </span>
      ),
    },
    { id: "type", header: "Type", size: 150, cell: (t) => label(t.type) },
    {
      id: "dueAt",
      header: "Due",
      sortable: true,
      size: 170,
      cell: (t) => (
        <RelativeTime value={t.dueAt} className={t.isOverdue ? "text-destructive" : ""} />
      ),
    },
    { id: "contact", header: "Contact", cell: (t) => <RefLink type="contact" value={t.contact} /> },
    { id: "company", header: "Company", cell: (t) => <RefLink type="company" value={t.company} /> },
    { id: "deal", header: "Deal", cell: (t) => <RefLink type="deal" value={t.deal} /> },
    {
      id: "owner",
      header: "Owner",
      cell: (t) => (
        <span className="inline-flex min-w-0 items-center gap-2">
          <UserAvatar name={t.ownerName} size="sm" />
          <span className="truncate">{t.ownerName ?? "No owner"}</span>
        </span>
      ),
    },
    {
      id: "origin",
      header: "Origin",
      size: 130,
      cell: (t) => <TaskOriginBadge origin={t.origin} />,
    },
    {
      id: "status",
      header: "Status",
      size: 120,
      cell: (t) => <StatusPill tone={TASK_STATUS_TONE[t.status]}>{label(t.status)}</StatusPill>,
    },
    {
      id: "createdAt",
      header: "Created",
      sortable: true,
      cell: (t) => <RelativeTime value={t.createdAt} />,
    },
    {
      id: "updatedAt",
      header: "Updated",
      sortable: true,
      cell: (t) => <RelativeTime value={t.updatedAt} />,
    },
  ];
}
