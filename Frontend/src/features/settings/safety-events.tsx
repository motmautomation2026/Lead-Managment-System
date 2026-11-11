import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/crm/empty-state";
import { useCursorList } from "@/store/server-hooks";
import { messageFromError } from "@/store";

interface SafetyEvent {
  id: string;
  kind: string;
  detail: string | null;
  at: string;
  numberLabel?: string | null;
}

/**
 * UX-1: a channel's whole safety-event history, newest first, 50 per page with Load more
 * (`GET /connections/<channel>/safety-events`).
 */
export function SafetyEventsList({
  queryKey,
  fetchPage,
  labels,
}: {
  queryKey: readonly unknown[];
  fetchPage: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ data: SafetyEvent[]; nextCursor: string | null }>;
  labels: Record<string, string>;
}) {
  const list = useCursorList(queryKey, fetchPage);
  const events = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <section aria-labelledby="safety-events" className="space-y-2">
      <h3 id="safety-events" className="type-section-title">
        Safety events
      </h3>
      {list.isLoading ? (
        <p className="type-small text-muted-foreground">Loading safety events…</p>
      ) : list.isError ? (
        <div className="space-y-2">
          <p className="type-small text-destructive">{messageFromError(list.error)}</p>
          <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
            Retry
          </Button>
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No safety events"
          text="Failures, pauses and resumes show here."
          className="py-6"
        />
      ) : (
        <>
          <ul className="divide-y rounded-lg border" aria-label="Safety events">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 px-3 py-2 type-small"
              >
                <span className="font-medium">
                  {event.numberLabel ? `${event.numberLabel} · ` : ""}
                  {labels[event.kind] ?? event.kind}
                </span>
                <span className="min-w-0 break-words text-muted-foreground">
                  {event.detail ? `${event.detail} · ` : ""}
                  {new Date(event.at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
          {list.hasNextPage && (
            <Button
              size="sm"
              variant="outline"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/** The 14-day table (fixed size: one row per IST day). */
export function DailyTable({
  rows,
  columns,
}: {
  rows: Array<Record<string, string | number>>;
  columns: Array<{ key: string; label: string }>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full type-small">
        <caption className="mb-1 text-left type-section-title">Last 14 days</caption>
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="py-1 font-normal">Date (IST)</th>
            {columns.map((c) => (
              <th key={c.key} className="py-1 text-right font-normal">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((day) => (
            <tr key={String(day["date"])} className="border-t">
              <td className="py-1">{day["date"]}</td>
              {columns.map((c) => (
                <td key={c.key} className="num py-1 text-right">
                  {day[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="type-label">{label}</dt>
      <dd className="num mt-1 type-body font-semibold">{value}</dd>
    </div>
  );
}
