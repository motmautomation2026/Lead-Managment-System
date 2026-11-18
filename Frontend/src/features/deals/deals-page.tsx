import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Columns3, Handshake, Search, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/crm/page-header";
import { FilterBar } from "@/components/crm/filter-bar";
import type { FilterDef } from "@/components/crm/filter-model";
import { DataTable } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { useCreateDealDialog } from "@/app/add-lead-context";
import { CompanyPicker } from "@/features/companies/company-picker";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useListUrlState } from "@/lib/use-list-url-state";
import { useListPrefs } from "@/lib/list-prefs";
import { cn } from "@/lib/utils";
import { useCompany, useDeals, useDealsCount, useSession, useUpdateDeal } from "@/store";
import { DEAL_STAGES, type DealListItem } from "@/types";
import { DEAL_COLUMNS } from "./deal-columns";
import { DEAL_STAGE_LABELS } from "./deal-labels";
import { DealBoard } from "./deal-board";
import {
  DEFAULT_COLUMNS,
  NO_FILTERS,
  dealsSearchSchema,
  fromFilterValues,
  parseSort,
  toApiParams,
  toBoardParams,
  toFilterValues,
  DEAL_VIEW_SPEC,
} from "./deals-search";
import { usePrefetchRecord } from "@/features/crm/prefetch";
import { useBulkAssignOwner } from "@/features/crm/bulk-assign";
import { SavedViewTabs } from "@/features/crm/saved-view-tabs";
import { toSavedViewBody } from "@/features/crm/saved-views";
import { useListViews } from "@/features/crm/use-list-views";

const EMPTY_TEXT: Record<string, string> = {
  mine: "You own no open deals.",
  closing: "No open deals are expected to close this month.",
  won: "No won deals yet.",
  lost: "No lost deals.",
};

const RecordPeek = lazy(() => import("@/features/crm/record-peek"));

export function DealsPage() {
  const [state, set] = useListUrlState(dealsSearchSchema);
  const prefs = useListPrefs("deals", state.columns, DEFAULT_COLUMNS);
  const navigate = useNavigate();
  const prefetch = usePrefetchRecord();
  const { users } = useSession();
  const createDeal = useCreateDealDialog();

  const board = state.layout === "board";
  const params = useMemo(() => toApiParams(state), [state]);
  const boardParams = useMemo(() => toBoardParams(state), [state]);
  const list = useDeals({ ...params, limit: prefs.limit }, !board);
  const count = useDealsCount(board ? boardParams : params);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  const updateOwner = useUpdateDeal();
  // UX-3: bulk Assign owner (PATCH /deals/:id ownerId); Undo restores each previous owner.
  const assign = useBulkAssignOwner({
    listKey: JSON.stringify(params),
    rows,
    noun: ["deal", "deals"],
    write: (id, ownerId) => updateOwner.mutateAsync({ id, input: { ownerId } }),
  });
  const filterCompany = useCompany(state.companyId);

  // The search box writes `q` once typing settles (only when the text changed, so
  // Back/Forward still restore older URLs).
  const [qInput, setQInput] = useState(state.q ?? "");
  const debouncedQ = useDebouncedValue(qInput, 300);
  const lastQ = useRef(debouncedQ);
  useEffect(() => {
    if (lastQ.current === debouncedQ) return;
    lastQ.current = debouncedQ;
    void set({ q: debouncedQ || undefined }, { replace: true });
  }, [debouncedQ, set]);

  const viewsCtl = useListViews(DEAL_VIEW_SPEC, state, set, (next) => {
    setQInput(next.q ?? "");
    lastQ.current = next.q ?? "";
  });
  const activeId = viewsCtl.activeId;
  const applyView = viewsCtl.apply;

  const quickFilters: FilterDef[] = [
    // The board's columns are the stages and its status comes from "Show closed".
    ...(board
      ? []
      : ([
          {
            id: "stage",
            label: "Stage",
            type: "multi",
            options: DEAL_STAGES.map((s) => ({ value: s, label: DEAL_STAGE_LABELS[s] })),
          },
        ] satisfies FilterDef[])),
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
    ...(board
      ? []
      : ([
          {
            id: "status",
            label: "Status",
            type: "multi",
            options: [
              { value: "open", label: "Open" },
              { value: "won", label: "Won" },
              { value: "lost", label: "Lost" },
              { value: "all", label: "All" },
            ],
          },
        ] satisfies FilterDef[])),
    { id: "amount", label: "Amount", type: "numberRange" },
    { id: "expectedClose", label: "Expected close", type: "dateRange" },
  ];
  const moreFilters: FilterDef[] = [{ id: "created", label: "Created", type: "dateRange" }];

  const hasFilters = Object.keys(toSavedViewBody(state, toApiParams).filters).length > 0;
  const emptyState = !hasFilters ? (
    <EmptyState
      icon={Handshake}
      title="No open deals"
      text="Deals are created when a meeting is booked or a proposal is made, or create one now."
      action={<Button onClick={() => createDeal.open()}>Create deal</Button>}
    />
  ) : (
    <EmptyState
      icon={Handshake}
      title="No deals match"
      text={EMPTY_TEXT[activeId] ?? "Try other filters or a different search."}
      action={
        <Button variant="outline" onClick={() => applyView("all")}>
          Show all open deals
        </Button>
      }
    />
  );

  return (
    <div className="pb-24">
      <PageHeader
        title="Deals"
        count={count.data?.count ?? null}
        primaryAction={<Button onClick={() => createDeal.open()}>Create deal</Button>}
        tabs={<SavedViewTabs controller={viewsCtl} />}
      />
      <div className="space-y-3 px-4 pt-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search deal or company"
              aria-label="Search deals"
              data-list-search
              className="pl-8"
            />
          </div>
          <CompanyPicker
            variant="chip"
            value={
              state.companyId
                ? { id: state.companyId, name: filterCompany.data?.name ?? "…" }
                : null
            }
            onChange={(company) => void set({ companyId: company?.id })}
          />
          <FilterBar
            filters={quickFilters}
            moreFilters={moreFilters}
            values={toFilterValues(state)}
            onChange={(values) => void set(fromFilterValues(values))}
          />
          <LayoutSwitch
            value={board ? "board" : "table"}
            onChange={(layout) => void set({ layout: layout === "board" ? "board" : undefined })}
          />
        </div>
        {board ? (
          <DealBoard
            params={boardParams}
            showClosed={Boolean(state.showClosed)}
            onShowClosedChange={(on) => void set({ showClosed: on ? "true" : undefined })}
          />
        ) : (
          <DataTable<DealListItem>
            label="Deals"
            data={rows}
            columns={DEAL_COLUMNS}
            getRowId={(r) => r.id}
            getRowHref={(r) => `/deals/${r.id}`}
            onRowIntent={(r) => prefetch("deal", r.id)}
            onRowClick={(r) => void set({ peek: r.id })}
            sort={parseSort(state.sort)}
            onSortChange={(s) => void set({ sort: `${s.field}:${s.dir}` })}
            visibleColumns={prefs.columns}
            onColumnsChange={(columns) => {
              prefs.rememberColumns(columns);
              void set({ columns });
            }}
            selectedIds={assign.selected}
            onSelectionChange={assign.setSelected}
            bulkActions={assign.bulkActions}
            pageSize={prefs.pageSize}
            onPageSizeChange={prefs.setPageSize}
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
      {assign.confirmDialog}
      {state.peek && (
        <Suspense fallback={null}>
          <RecordPeek type="deal" id={state.peek} onClose={() => void set({ peek: undefined })} />
        </Suspense>
      )}
    </div>
  );
}

/** Table | Board, kept in the URL (`layout`); the filters are shared. */
function LayoutSwitch({
  value,
  onChange,
}: {
  value: "table" | "board";
  onChange: (value: "table" | "board") => void;
}) {
  const options = [
    { id: "table", label: "Table", icon: Table2 },
    { id: "board", label: "Board", icon: Columns3 },
  ] as const;
  return (
    <div role="group" aria-label="Layout" className="ml-auto inline-flex rounded-md border p-0.5">
      {options.map((o) => (
        <Button
          key={o.id}
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn("h-7 gap-1.5 px-2.5", value === o.id && "bg-accent text-accent-foreground")}
        >
          <o.icon /> {o.label}
        </Button>
      ))}
    </div>
  );
}
