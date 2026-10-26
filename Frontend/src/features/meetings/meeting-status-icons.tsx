import { AlertTriangle, CalendarCheck, Clock, Mail, MessageCircle } from "lucide-react";
import { label } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { MeetingListItem } from "@/types";

const dash = <span className="text-muted-foreground">–</span>;

const TONE: Record<string, string> = {
  sent: "text-success-soft-foreground",
  synced: "text-success-soft-foreground",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
};

/** Icon + accessible text; the error (if any) is the hover tooltip. */
function StatusIcon({
  icon: Icon,
  what,
  status,
  error,
}: {
  icon: typeof Mail;
  what: string;
  status: string;
  error?: string | undefined;
}) {
  const text = `${what}: ${label(status)}${error ? ` — ${error}` : ""}`;
  return (
    <span
      title={text}
      aria-label={text}
      role="img"
      className={cn("inline-flex", TONE[status] ?? "text-info-soft-foreground")}
    >
      {status === "failed" ? <AlertTriangle className="size-4" /> : <Icon className="size-4" />}
    </span>
  );
}

export function CalendarSyncIcon({ meeting }: { meeting: MeetingListItem }) {
  if (meeting.calendarSyncStatus === "not_applicable") return dash;
  return (
    <StatusIcon
      icon={meeting.calendarSyncStatus === "pending" ? Clock : CalendarCheck}
      what="Calendar"
      status={meeting.calendarSyncStatus}
      error={meeting.calendarSyncError}
    />
  );
}

export function NotifyIcons({ meeting }: { meeting: MeetingListItem }) {
  const email = meeting.notifyEmailStatus ?? "not_applicable";
  const whatsapp = meeting.notifyWhatsappStatus ?? "not_applicable";
  if (email === "not_applicable" && whatsapp === "not_applicable") return dash;
  return (
    <span className="inline-flex items-center gap-2">
      {email !== "not_applicable" && (
        <StatusIcon icon={Mail} what="Email" status={email} error={meeting.notifyEmailError} />
      )}
      {whatsapp !== "not_applicable" && (
        <StatusIcon
          icon={MessageCircle}
          what="WhatsApp"
          status={whatsapp}
          error={meeting.notifyWhatsappError}
        />
      )}
    </span>
  );
}
