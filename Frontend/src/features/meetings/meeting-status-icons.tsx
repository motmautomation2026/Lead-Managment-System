import { AlertTriangle, CalendarCheck, Clock, Mail, MessageCircle } from "lucide-react";
import { StatusPill, type PillTone } from "@/components/crm/status-pill";
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
export function StatusIcon({
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

const EMAIL_STATUS: Record<string, [string, PillTone]> = {
  pending: ["Queued", "info"],
  sent: ["Sent", "success"],
  failed: ["Failed", "danger"],
  skipped: ["Skipped", "neutral"],
};

/**
 * E1b: an email is only queued by the request and sent by the worker, so its state is shown,
 * never assumed: "Email: Queued / Sent / Failed". The reason (why it waits or failed) is the
 * tooltip, and visible with `showReason`.
 */
export function EmailStatusPill({
  status,
  error,
  showReason = false,
}: {
  status: string;
  error?: string | undefined;
  showReason?: boolean;
}) {
  const [text, tone] = EMAIL_STATUS[status] ?? [label(status), "neutral" as const];
  const reason = status === "sent" ? undefined : error;
  return (
    <span className="inline-flex min-w-0 flex-col gap-0.5">
      <span title={reason ? `Email ${text.toLowerCase()} — ${reason}` : undefined}>
        <StatusPill tone={tone}>
          <Mail className="size-3" aria-hidden />
          Email: {text}
        </StatusPill>
      </span>
      {showReason && reason && <span className="type-small text-muted-foreground">{reason}</span>}
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

export function NotifyIcons({
  meeting,
  showReason = false,
}: {
  meeting: MeetingListItem;
  showReason?: boolean;
}) {
  const email = meeting.notifyEmailStatus ?? "not_applicable";
  const whatsapp = meeting.notifyWhatsappStatus ?? "not_applicable";
  if (email === "not_applicable" && whatsapp === "not_applicable") return dash;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {email !== "not_applicable" && (
        <EmailStatusPill status={email} error={meeting.notifyEmailError} showReason={showReason} />
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
