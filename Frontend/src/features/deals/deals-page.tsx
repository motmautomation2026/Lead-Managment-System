import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Columns3, Handshake, MoreHorizontal, Search, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { PageHeader } from "@/components/crm/page-header";
import { ViewTabs } from "@/components/crm/view-tabs";
import { FilterBar } from "@/components/crm/filter-bar";
import type { FilterDef } from "@/components/crm/filter-model";
import { DataTable } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { useCreateDealDialog } from "@/app/add-lead-context";
import { CompanyPicker } from "@/features/companies/company-picker";
import { ViewNameDialog } from "@/features/contacts/view-name-dialog";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useListUrlState } from "@/lib/use-list-url-state";
import { cn } from "@/lib/utils";
import {
  messageFromError,
  useCompany,
  useCreateSavedView,
  useDeals,
  useDealsCount,
  useDeleteSavedView,
  useIsAdmin,
  useSavedViews,
  useSession,
  useUpdateSavedView,
} from "@/store";
import { DEAL_STAGES, type DealListItem } from "@/types";
import { DEAL_COLUMNS } from "./deal-columns";
import { DEAL_STAGE_LABELS } from "./deal-labels";
import { DealBoard } from "./deal-board";
import {
  BUILT_IN_VIEWS,
  DEFAULT_COLUMNS,
  NO_FILTERS,
  dealsSearchSchema,
  fromFilterValues,
  parseSort,
  savedViewState,
  toApiParams,
  toBoardParams,
  toFilterValues,
  toSavedViewBody,
  type DealView,
} from "./deals-search";

const EMPTY_TEXT: Record<string, string> = {
  mine: "You own no open deals.",
  closing: "No open deals are expected to close this month.",
  won: "No won deals yet.",
  lost: "No lost deals.",
};

export function DealsPage() {
  const [state, set] = useListUrlState(dealsSearchSchema);
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const { users } = useSession();
  const createDeal = useCreateDealDialog();
  const [saveOpen, setSaveOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const board = state.layout === "board";
  const params = useMemo(() => toApiParams(state), [state]);
  const boardParams = useMemo(() => toBoardParams(state), [state]);
  const list = useDeals(params, !board);
  const count = useDealsCount(board ? boardParams : params);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  const filterCompany = useCompany(state.companyId);
  const savedViews = useSavedViews("deals");
  const createView = useCreateSavedView();
  const updateView = useUpdateSavedView();
  const deleteView = useDeleteSavedView();

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

  const views: DealView[] = [
    ...BUILT_IN_VIEWS,
    ...(savedViews.data?.data ?? []).map((v) => ({
      id: v.id,
      label: v.isShared ? `${v.name} · Shared` : v.name,
      state: () => savedViewState(v),
      saved: v,
    })),
  ];
  const activeId = state.view ?? "all";
  const activeSaved = views.find((v) => v.id === activeId)?.saved;
  const canManageView = Boolean(
    activeSaved && (activeSaved.isMine || (isAdmin && activeSaved.isShared)),
  );
  const applyView = (id: string) => {
    const view = views.find((v) => v.id === id) ?? BUILT_IN_VIEWS[0]!;
    const next = view.state();
    setQInput(next.q ?? "");
    lastQ.current = next.q ?? "";
    void set({ ...NO_FILTERS, ...next, view: id === "all" ? undefined : id });
  };

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

  const hasFilters = Object.keys(toSavedViewBody(state).filters).length > 0;
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
        tabs={
          <div className="flex items-end gap-1">
            <div className="min-w-0 flex-1">
              <ViewTabs
                views={views}
                activeId={activeId}
                onChange={applyView}
                onSaveView={() => setSaveOpen(true)}
              />
            </div>
            {canManageView && (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mb-1 size-8 shrink-0"
                    aria-label="View options"
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                    Rename view…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDeleteOpen(true)}>
                    Delete view
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        }
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
            onRowClick={(r) => void navigate({ to: "/deals/$dealId", params: { dealId: r.id } })}
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

      <ViewNameDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="Save view"
        showShare
        saving={createView.isPending}
        onSave={(value) =>
          void createView
            .mutateAsync({ object: "deals", ...value, ...toSavedViewBody(state) })
            .then((view) => {
              toast.success("View saved");
              setSaveOpen(false);
              void set({ view: view.id });
            })
            .catch((error: unknown) => toast.error(messageFromError(error)))
        }
      />
      {activeSaved && (
        <>
          <ViewNameDialog
            open={renameOpen}
            onOpenChange={setRenameOpen}
            title="Rename view"
            initialName={activeSaved.name}
            initialShared={activeSaved.isShared}
            showShare={activeSaved.isMine}
            saving={updateView.isPending}
            onSave={(value) =>
              void updateView
                .mutateAsync({ id: activeSaved.id, input: value })
                .then(() => {
                  toast.success("View renamed");
                  setRenameOpen(false);
                })
                .catch((error: unknown) => toast.error(messageFromError(error)))
            }
          />
          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title={`Delete the view "${activeSaved.name}"?`}
            description={
              activeSaved.isShared
                ? "It is shared, so it disappears for everyone in this workspace. Deals are not affected."
                : "Deals are not affected."
            }
            disabled={deleteView.isPending}
            onConfirm={() =>
              void deleteView
                .mutateAsync(activeSaved.id)
                .then(() => {
                  toast.success("View deleted");
                  setDeleteOpen(false);
                  applyView("all");
                })
                .catch((error: unknown) => toast.error(messageFromError(error)))
            }
          />
        </>
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
