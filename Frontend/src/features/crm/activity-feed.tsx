import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/common/status-badge";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import { EmptyState } from "@/components/crm/empty-state";
import { RelativeTime } from "@/components/crm/relative-time";
import { ACTIVITY_FILTERS, type ActivityFilter } from "@/features/contacts/contact-helpers";
import { cn } from "@/lib/utils";
import { useCompanyTimeline, useContactTimeline } from "@/store";
import type { CompanyTimelineEvent, TimelineEvent } from "@/types";

type Source = { contactId: string; companyId?: never } | { companyId: string; contactId?: never };

/**
 * A paginated timeline (GET /contacts/:id/timeline or /companies/:id/timeline), newest
 * first, with the Activity type chips filtering server-side and "Load more". Company feeds
 * show whose event each row is. `limit` renders only the first N rows, without chips (Overview).
 */
export function ActivityFeed({ limit, ...source }: Source & { limit?: number }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const kind = filter === "all" ? [] : [filter];
  // Both hooks run; the one without an id stays disabled.
  const contactFeed = useContactTimeline(source.contactId ?? "", kind);
  const companyFeed = useCompanyTimeline(source.companyId ?? "", kind);
  const feed = source.companyId ? companyFeed : contactFeed;
  const all: Array<TimelineEvent | CompanyTimelineEvent> =
    feed.data?.pages.flatMap((p) => p.data) ?? [];
  const events = limit ? all.slice(0, limit) : all;

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
            <div key={event.id} className="flex gap-3 px-4 py-3">
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
