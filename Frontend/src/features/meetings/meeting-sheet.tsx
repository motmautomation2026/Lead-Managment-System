import { Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PropertyList } from "@/components/crm/property-list";
import { RelativeTime } from "@/components/crm/relative-time";
import { StatusPill } from "@/components/crm/status-pill";
import { RefLink } from "@/features/work/ref-link";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/labels";
import type { MeetingListItem } from "@/types";
import { MEETING_STATUS_TONE, canRecordOutcome, joinLink } from "./meeting-labels";
import { CalendarSyncIcon, NotifyIcons } from "./meeting-status-icons";

/** A meeting's row Sheet: details and actions; the dialogs live on the page. */
export function MeetingSheet({
  meeting,
  onOpenChange,
  onReschedule,
  onRecordOutcome,
  onCancel,
}: {
  meeting: MeetingListItem | null;
  onOpenChange: (open: boolean) => void;
  onReschedule: (m: MeetingListItem) => void;
  onRecordOutcome: (m: MeetingListItem) => void;
  onCancel: (m: MeetingListItem) => void;
}) {
  const m = meeting;
  const href = m ? joinLink(m) : undefined;
  return (
    <Sheet open={Boolean(m)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        {m && (
          <>
            <SheetHeader className="border-b">
              <SheetTitle className="pr-6">{m.title}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <StatusPill tone={MEETING_STATUS_TONE[m.status]}>{label(m.status)}</StatusPill>
                <span>{fmtDateTime(m.at)} IST</span>
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 p-4">
              <PropertyList
                items={[
                  { id: "when", label: "When", value: <RelativeTime value={m.at} /> },
                  { id: "duration", label: "Duration", value: `${m.durationMin} min` },
                  { id: "owner", label: "Owner", value: m.ownerName ?? "No owner" },
                  {
                    id: "contact",
                    label: "Contact",
                    value: <RefLink type="contact" value={m.contact} />,
                  },
                  {
                    id: "company",
                    label: "Company",
                    value: <RefLink type="company" value={m.company} />,
                  },
                  { id: "deal", label: "Deal", value: <RefLink type="deal" value={m.deal} /> },
                  { id: "outcome", label: "Outcome", value: m.outcome ? label(m.outcome) : null },
                  { id: "calendar", label: "Calendar", value: <CalendarSyncIcon meeting={m} /> },
                  {
                    id: "notify",
                    label: "Notifications",
                    value: <NotifyIcons meeting={m} showReason />,
                  },
                  ...(m.notes ? [{ id: "notes", label: "Notes", value: m.notes }] : []),
                ]}
              />
              <div className="flex flex-wrap gap-2">
                {href && (
                  <Button asChild size="sm">
                    <a href={href} target="_blank" rel="noreferrer">
                      <Video /> Join
                    </a>
                  </Button>
                )}
                {m.status !== "completed" && (
                  <Button size="sm" variant="outline" onClick={() => onReschedule(m)}>
                    Edit / reschedule
                  </Button>
                )}
                {canRecordOutcome(m) && (
                  <Button size="sm" variant="outline" onClick={() => onRecordOutcome(m)}>
                    Record outcome
                  </Button>
                )}
                {m.status !== "cancelled" && m.status !== "completed" && (
                  <Button size="sm" variant="outline" onClick={() => onCancel(m)}>
                    Cancel meeting
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
