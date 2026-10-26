import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarDays, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/crm/page-header";
import { FilterBar } from "@/components/crm/filter-bar";
import type { FilterDef } from "@/components/crm/filter-model";
import { DataTable } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { RelativeTime } from "@/components/crm/relative-time";
import { StatusPill } from "@/components/crm/status-pill";
import { ErrorBlock } from "@/components/common/server-state";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useScheduleMeetingDialog } from "@/app/add-lead-context";
import { CompanyPicker } from "@/features/companies/company-picker";
import { SavedViewTabs } from "@/features/crm/saved-view-tabs";
import { toSavedViewBody } from "@/features/crm/saved-views";
import { useListViews } from "@/features/crm/use-list-views";
import { OutcomeDialog } from "@/features/work/meeting-outcome-dialog";
import { ScheduleMeetingFlow } from "@/features/work/schedule-meeting-flow";
import { ContactFilter, DealFilterChip } from "@/features/work/work-filters";
import { label } from "@/lib/labels";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useListUrlState } from "@/lib/use-list-url-state";
import { useMediaQuery } from "@/lib/use-media-query";
import {
  messageFromError,
  useCompany,
  useMeetingCount,
  useMeetingList,
  useRecordMeetingOutcome,
  useSession,
  useUpdateMeeting,
} from "@/store";
import { MEETING_STATUSES, type MeetingListItem } from "@/types";
import { MEETING_COLUMNS } from "./meeting-columns";
import { MEETING_STATUS_TONE } from "./meeting-labels";
import { MeetingSheet } from "./meeting-sheet";
import {
  DEFAULT_COLUMNS,
  MEETING_VIEW_SPEC,
  NEEDS_OUTCOME,
  fromFilterValues,
  meetingsSearchSchema,
  parseSort,
  toApiParams,
  toFilterValues,
} from "./meetings-search";

const EMPTY_TEXT: Record<string, string> = {
  upcoming: "No upcoming meetings.",
  today: "No meetings today.",
  needs_outcome: "Every past meeting has an outcome.",
  completed: "No completed meetings yet.",
  cancelled: "No cancelled meetings.",
};

export function MeetingsPage() {
  const [state, set] = useListUrlState(meetingsSearchSchema);
  const { users } = useSession();
  const schedule = useScheduleMeetingDialog();
  const narrow = useMediaQuery("(max-width: 767px)");

  const params = useMemo(() => toApiParams(state), [state]);
  // A bare /meetings is rewritten to Upcoming first (useListViews); don't fetch "all" meanwhile.
  const landing = Object.keys(state).length === 0;
  const list = useMeetingList(params, !landing);
  const count = useMeetingCount(params, !landing);
  const needsOutcome = useMeetingCount(NEEDS_OUTCOME);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  const filterCompany = useCompany(state.companyId);
  const update = useUpdateMeeting();
  const recordOutcome = useRecordMeetingOutcome();

  const [qInput, setQInput] = useState(state.q ?? "");
  const debouncedQ = useDebouncedValue(qInput, 300);
  const lastQ = useRef(debouncedQ);
  useEffect(() => {
    if (lastQ.current === debouncedQ) return;
    lastQ.current = debouncedQ;
    void set({ q: debouncedQ || undefined }, { replace: true });
  }, [debouncedQ, set]);

  const viewsCtl = useListViews(MEETING_VIEW_SPEC, state, set, (next) => {
    setQInput(next.q ?? "");
    lastQ.current = next.q ?? "";
  });

  const [sheet, setSheet] = useState<MeetingListItem | null>(null);
  const [editing, setEditing] = useState<MeetingListItem | null>(null);
  const [outcomeFor, setOutcomeFor] = useState<MeetingListItem | null>(null);
  const [cancelling, setCancelling] = useState<MeetingListItem | null>(null);

  const quickFilters: FilterDef[] = [
    {
      id: "ownerId",
      label: "Owner",
      type: "multi",
      options: [
        { value: "me", label: "Me" },
        { value: "none", label: "No owner" },
        ...users.map((u) => ({ value: u.id, label: u.name })),
      ],
    },
    {
      id: "status",
      label: "Status",
      type: "multi",
      options: MEETING_STATUSES.map((s) => ({ value: s, label: label(s) })),
    },
    { id: "dateRange", label: "Date", type: "dateRange" },
  ];

  const hasFilters = Object.keys(toSavedViewBody(state, toApiParams).filters).length > 0;
  const scheduleButton = <Button onClick={() => schedule.open()}>Schedule meeting</Button>;
  const emptyState = (
    <EmptyState
      icon={CalendarDays}
      title={hasFilters ? "No meetings here" : "No meetings yet"}
      text={EMPTY_TEXT[viewsCtl.activeId] ?? "Try other filters or a different search."}
      action={scheduleButton}
    />
  );

  return (
    <div className="pb-24">
      <PageHeader
        title="Meetings"
        count={count.data?.count ?? null}
        primaryAction={scheduleButton}
        tabs={
          <SavedViewTabs
            controller={viewsCtl}
            maxVisible={6}
            counts={{ needs_outcome: needsOutcome.data?.count }}
          />
        }
      />
      <div className="space-y-3 px-4 pt-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search title or contact"
              aria-label="Search meetings"
              data-list-search
              className="pl-8"
            />
          </div>
          <ContactFilter
            contactId={state.contactId}
            onChange={(contactId) => void set({ contactId })}
          />
          <CompanyPicker
            variant="chip"
            value={
              state.companyId
                ? { id: state.companyId, name: filterCompany.data?.name ?? "…" }
                : null
            }
            onChange={(company) => void set({ companyId: company?.id })}
          />
          <DealFilterChip dealId={state.dealId} onClear={() => void set({ dealId: undefined })} />
          <FilterBar
            filters={quickFilters}
            values={toFilterValues(state)}
            onChange={(values) => void set(fromFilterValues(values))}
          />
        </div>
        {narrow ? (
          <MeetingCards
            rows={rows}
            isLoading={list.isLoading}
            error={list.error}
            hasNextPage={list.hasNextPage}
            onLoadMore={() => void list.fetchNextPage()}
            onOpen={setSheet}
            emptyState={emptyState}
          />
        ) : (
          <DataTable<MeetingListItem>
            label="Meetings"
            data={rows}
            columns={MEETING_COLUMNS}
            getRowId={(r) => r.id}
            onRowClick={setSheet}
            sort={parseSort(state.sort)}
            onSortChange={(s) => void set({ sort: `${s.field}:${s.dir}` })}
            visibleColumns={state.columns ?? DEFAULT_COLUMNS}
            onColumnsChange={(columns) => void set({ columns })}
            hasNextPage={list.hasNextPage}
            isFetchingNextPage={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
            isLoading={list.isLoading}
            error={list.error}
            onRetry={() => void list.refetch()}
            emptyState={emptyState}
          />
        )}
      </div>

      <MeetingSheet
        meeting={sheet}
        onOpenChange={(open) => !open && setSheet(null)}
        onReschedule={(m) => {
          setSheet(null);
          setEditing(m);
        }}
        onRecordOutcome={(m) => {
          setSheet(null);
          setOutcomeFor(m);
        }}
        onCancel={(m) => {
          setSheet(null);
          setCancelling(m);
        }}
      />
      {editing && (
        <ScheduleMeetingFlow
          meeting={editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
      <OutcomeDialog
        open={Boolean(outcomeFor)}
        onOpenChange={(open) => !open && setOutcomeFor(null)}
        onSave={(outcome, notes) => {
          if (!outcomeFor) return;
          recordOutcome
            .mutateAsync({ id: outcomeFor.id, outcome, notes: notes || undefined })
            .then(() => {
              toast.success("Outcome recorded");
              setOutcomeFor(null);
            })
            .catch((error: unknown) => toast.error(messageFromError(error)));
        }}
      />
      <ConfirmDialog
        open={Boolean(cancelling)}
        onOpenChange={(open) => !open && setCancelling(null)}
        title="Cancel meeting"
        description={
          cancelling
            ? `Cancel "${cancelling.title}"? The calendar event is cancelled too, and its prep task is closed.`
            : ""
        }
        confirmLabel="Cancel meeting"
        disabled={update.isPending}
        onConfirm={() => {
          if (!cancelling) return;
          update
            .mutateAsync({ id: cancelling.id, input: { status: "cancelled" } })
            .then(() => {
              toast.success("Meeting cancelled");
              setCancelling(null);
            })
            .catch((error: unknown) => toast.error(messageFromError(error)));
        }}
      />
    </div>
  );
}

/** Phone width: one card per meeting (date, title, contact, status) instead of the table. */
function MeetingCards({
  rows,
  isLoading,
  error,
  hasNextPage,
  onLoadMore,
  onOpen,
  emptyState,
}: {
  rows: MeetingListItem[];
  isLoading: boolean;
  error: unknown;
  hasNextPage: boolean;
  onLoadMore: () => void;
  onOpen: (m: MeetingListItem) => void;
  emptyState: ReactNode;
}) {
  if (isLoading)
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  if (error) return <ErrorBlock error={error} />;
  if (rows.length === 0) return <>{emptyState}</>;
  return (
    <div className="space-y-2">
      <ul className="space-y-2" aria-label="Meetings">
        {rows.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => onOpen(m)}
              className="w-full rounded-lg border bg-card p-3 text-left hover:bg-accent/40"
            >
              <div className="flex items-start justify-between gap-2">
                <RelativeTime value={m.at} className="type-small text-muted-foreground" />
                <StatusPill tone={MEETING_STATUS_TONE[m.status]}>{label(m.status)}</StatusPill>
              </div>
              <div className="mt-1 type-body font-medium">{m.title}</div>
              <div className="type-small text-muted-foreground">{m.contact.name}</div>
            </button>
          </li>
        ))}
      </ul>
      {hasNextPage && (
        <Button variant="outline" className="w-full" onClick={onLoadMore}>
          Load more
        </Button>
      )}
    </div>
  );
}
