import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/common/status-badge";
import { StatusPill, type PillTone } from "@/components/crm/status-pill";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import { EmptyState } from "@/components/crm/empty-state";
import { RelativeTime } from "@/components/crm/relative-time";
import { ACTIVITY_FILTERS, type ActivityFilter } from "@/features/contacts/contact-helpers";
import { cn } from "@/lib/utils";
import { REPLY_LABEL_TEXT } from "@/features/agent/agent-labels";
import { SuggestedReplyCard } from "./suggested-reply-card";
import {
  messageFromError,
  useCompanyTimeline,
  useContactTimeline,
  useCorrectReplyLabel,
  useDealTimeline,
  useInboundReply,
} from "@/store";
import {
  REPLY_LABELS,
  type CompanyTimelineEvent,
  type ReplyLabel,
  type TimelineEvent,
} from "@/types";

type Reply = NonNullable<TimelineEvent["reply"]>;

type Source =
  | { contactId: string; companyId?: never; dealId?: never }
  | { companyId: string; contactId?: never; dealId?: never }
  | { dealId: string; contactId?: never; companyId?: never };

/**
 * A paginated timeline (GET /contacts|companies|deals/:id/timeline), newest first, with the
 * Activity type chips filtering server-side and "Load more". Company and deal feeds show whose
 * event each row is. `limit` renders only the first N rows, without chips (Overview).
 * Contact feeds (D2): inbound WhatsApp replies get "Show message" for the owner and admins;
 * `focusReply` scrolls to the newest reply once it has loaded.
 */
export function ActivityFeed({
  limit,
  initialFilter = "all",
  focusReply = false,
  onDraftDone,
  ...source
}: Source & {
  limit?: number;
  initialFilter?: ActivityFilter | undefined;
  focusReply?: boolean;
  /** Passed to each Suggested reply card (UX-2 Replies queue). */
  onDraftDone?: (action: "sent" | "discarded") => void;
}) {
  const [filter, setFilter] = useState<ActivityFilter>(initialFilter);
  const kind = [...(ACTIVITY_FILTERS.find((f) => f.id === filter)?.kinds ?? [])];
  // All hooks run; the ones without an id stay disabled.
  const contactFeed = useContactTimeline(source.contactId ?? "", kind);
  const companyFeed = useCompanyTimeline(source.companyId ?? "", kind);
  const dealFeed = useDealTimeline(source.dealId ?? "", kind);
  const feed = source.dealId ? dealFeed : source.companyId ? companyFeed : contactFeed;
  const all: Array<TimelineEvent | CompanyTimelineEvent> =
    feed.data?.pages.flatMap((p) => p.data) ?? [];
  const events = limit ? all.slice(0, limit) : all;
  const focusId = focusReply ? events.find((e) => e.reply)?.id : undefined;
  const focused = useRef(false);
  useEffect(() => {
    if (!focusId || focused.current) return;
    focused.current = true;
    document.getElementById(`activity-${focusId}`)?.scrollIntoView?.({ block: "center" });
  }, [focusId]);

  return (
    <div className="space-y-3">
      {!limit && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Activity type">
          {ACTIVITY_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                filter === f.id
                  ? "border-primary bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
      {feed.isLoading ? (
        <LoadingBlock label="Loading activity…" />
      ) : feed.error ? (
        <ErrorBlock error={feed.error} />
      ) : events.length === 0 ? (
        <EmptyState title={filter === "all" ? "No activity yet" : "Nothing of this type yet"} />
      ) : (
        <Card className="divide-y p-0">
          {events.map((event) => (
            <div
              key={event.id}
              id={`activity-${event.id}`}
              className={cn("flex gap-3 px-4 py-3", event.id === focusId && "bg-accent/40")}
            >
              <RelativeTime
                value={event.at}
                className="w-28 shrink-0 type-small text-muted-foreground"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="type-body font-medium">{event.title}</span>
                  <StatusBadge
                    value={event.source}
                    tone={event.source === "automation" ? "primary" : "muted"}
                  />
                </div>
                {event.detail && (
                  <p className="pt-0.5 type-body break-words text-muted-foreground">
                    {event.detail}
                  </p>
                )}
                {event.reply && source.contactId && (
                  <>
                    <ReplyLabelLine contactId={source.contactId} reply={event.reply} />
                    <ReplyText contactId={source.contactId} reply={event.reply} />
                    {event.reply.drafting && <p className={muted}>Writing a suggested reply…</p>}
                    {event.reply.draft && (
                      <SuggestedReplyCard
                        key={event.reply.draft.id}
                        contactId={source.contactId}
                        draft={event.reply.draft}
                        onDone={onDraftDone}
                      />
                    )}
                  </>
                )}
                <div className="pt-0.5 type-small text-muted-foreground">
                  {"contact" in event && (
                    <>
                      <Link
                        to="/contacts/$contactId"
                        params={{ contactId: event.contact.id }}
                        className="font-medium text-foreground hover:underline"
                      >
                        {event.contact.name || "Unnamed contact"}
                      </Link>
                      {" · "}
                    </>
                  )}
                  {event.actor}
                </div>
              </div>
            </div>
          ))}
        </Card>
      )}
      {!limit && feed.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={feed.isFetchingNextPage}
            onClick={() => void feed.fetchNextPage()}
          >
            {feed.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}

const muted = "pt-1 type-small text-muted-foreground";

/**
 * D2: one reply's text, requested only after "Show message" (each request is audited).
 * Hiding or unmounting drops it from the cache (useInboundReply).
 */
function ReplyText({ contactId, reply }: { contactId: string; reply: Reply }) {
  const [shown, setShown] = useState(false);
  const query = useInboundReply(contactId, reply.messageId, shown && reply.canRead, reply.channel);
  if (!reply.canRead)
    return <p className={muted}>Only the contact owner and admins can read replies.</p>;
  const toggle = (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0"
      aria-expanded={shown}
      onClick={() => setShown((v) => !v)}
    >
      {shown ? "Hide" : "Show message"}
    </Button>
  );
  if (!shown) return <div className="pt-1">{toggle}</div>;
  const data = query.data;
  return (
    <div className="space-y-1 pt-1">
      {query.isLoading ? (
        <p className={muted}>Loading message…</p>
      ) : query.error ? (
        <ErrorBlock error={query.error} />
      ) : data?.text != null ? (
        <>
          {data.subject && <p className="type-small font-medium break-words">{data.subject}</p>}
          <blockquote className="border-l-2 pl-3 type-body break-words whitespace-pre-wrap">
            {data.text}
          </blockquote>
          {data.truncated && <p className={muted}>(shortened — the message was longer)</p>}
        </>
      ) : (
        <p className={muted}>
          {data?.reason === "unreadable"
            ? "This message can't be read any more (the encryption key changed)."
            : reply.channel === "email"
              ? "The text of this email wasn't stored."
              : "The text of this message wasn't stored (e.g. a sticker or voice note)."}
        </p>
      )}
      {toggle}
    </div>
  );
}

const REPLY_LABEL_TONE: Record<ReplyLabel, PillTone> = {
  asked_to_stop: "danger",
  not_interested: "warning",
  annoyed: "warning",
  positive: "success",
  question: "info",
  other: "neutral",
  unclassified: "neutral",
};
const CORRECTABLE = REPLY_LABELS.filter(
  (l): l is Exclude<ReplyLabel, "unclassified"> => l !== "unclassified",
);

/**
 * D4a: what the reply says (never the text) and who decided it; the owner and admins can
 * change it. A change re-titles the reply task but never undoes an opt-out or a stopped AI.
 */
function ReplyLabelLine({ contactId, reply }: { contactId: string; reply: Reply }) {
  const correct = useCorrectReplyLabel(contactId);
  if (!reply.label && !reply.classifying) return null;
  const by =
    reply.labelSource === "rep"
      ? `by ${reply.labelBy ?? "a rep"}`
      : reply.labelSource === "ai"
        ? "by AI"
        : reply.labelSource === "keyword"
          ? "by keyword"
          : null;
  const change = (label: Exclude<ReplyLabel, "unclassified">) =>
    correct.mutate(
      { messageId: reply.messageId, label, channel: reply.channel },
      {
        onSuccess: () => toast.success(`Reply marked "${REPLY_LABEL_TEXT[label]}"`),
        onError: (error) => toast.error(messageFromError(error)),
      },
    );
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1 type-small text-muted-foreground">
      {reply.label ? (
        <StatusPill tone={REPLY_LABEL_TONE[reply.label]}>
          {REPLY_LABEL_TEXT[reply.label]}
        </StatusPill>
      ) : (
        <StatusPill>Classifying…</StatusPill>
      )}
      {reply.label && by && <span>{by}</span>}
      {reply.canCorrect && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              disabled={correct.isPending}
              aria-label="Change reply label"
            >
              Change
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {CORRECTABLE.map((label) => (
              <DropdownMenuItem
                key={label}
                disabled={label === reply.label}
                onSelect={() => change(label)}
              >
                {REPLY_LABEL_TEXT[label]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** The 4A reply task's title (backend whatsapp-inbound.service.ts REPLY_TASK_TITLE). */
export const REPLY_TASK_TITLE = "Lead replied on WhatsApp — respond today";

/** D2: opens the contact's Activity filtered to messages, scrolled to the newest reply. */
export function ReadReplyLink({ contactId }: { contactId: string }) {
  return (
    <Link
      to="/contacts/$contactId"
      params={{ contactId }}
      search={{ tab: "activity", activity: "messages", reply: "latest" }}
      className="type-small font-medium text-primary hover:underline"
    >
      Read reply
    </Link>
  );
}
