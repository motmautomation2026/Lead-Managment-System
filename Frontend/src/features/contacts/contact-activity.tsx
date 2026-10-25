import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/common/status-badge";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import { EmptyState } from "@/components/crm/empty-state";
import { RelativeTime } from "@/components/crm/relative-time";
import { cn } from "@/lib/utils";
import { useTimeline } from "@/store";
import { ACTIVITY_FILTERS, activityType, type ActivityFilter } from "./contact-helpers";

/** The contact's timeline, newest first. /leads/:id/timeline does not page: everything renders. */
export function ContactActivity({ leadId }: { leadId: string }) {
  const { timeline, isLoading, error } = useTimeline(leadId);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const events = useMemo(
    () =>
      timeline
        .filter((e) => filter === "all" || activityType(e) === filter)
        .sort((a, b) => b.at.localeCompare(a.at)),
    [timeline, filter],
  );

  return (
    <div className="space-y-3">
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
      {isLoading ? (
        <LoadingBlock label="Loading activity…" />
      ) : error ? (
        <ErrorBlock error={error} />
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
                <div className="pt-0.5 type-small text-muted-foreground">{event.actor}</div>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
