import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Building2, CopyCheck, MoreHorizontal, Search } from "lucide-react";
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
import { DataTable, type DataTableColumn } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { UserAvatar } from "@/components/crm/user-avatar";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";
import { useCreateCompanyDialog } from "@/app/add-lead-context";
import { ViewNameDialog } from "@/features/contacts/view-name-dialog";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useListUrlState } from "@/lib/use-list-url-state";
import {
  messageFromError,
  useCompanies,
  useCompaniesCount,
  useCompanyDuplicatesCount,
  useCompanyIndustries,
  useCreateSavedView,
  useDeleteSavedView,
  useIsAdmin,
  useSavedViews,
  useSession,
  useUpdateSavedView,
} from "@/store";
import type { CompanyListItem } from "@/types";
import {
  BUILT_IN_VIEWS,
  DEFAULT_COLUMNS,
  NO_FILTERS,
  companiesSearchSchema,
  fromFilterValues,
  parseSort,
  savedViewState,
  toApiParams,
  toFilterValues,
  toSavedViewBody,
  type CompanyView,
} from "./companies-search";

const dash = <span className="text-muted-foreground">–</span>;

const COMPANY_COLUMNS: DataTableColumn<CompanyListItem>[] = [
  {
    id: "name",
    header: "Name",
    sortable: true,
    hideable: false,
    size: 240,
    cell: (r) => (
      <span className="inline-flex min-w-0 items-center gap-2 font-medium">
        <UserAvatar name={r.name} size="sm" className="rounded-md" />
        <span className="truncate">{r.name}</span>
      </span>
    ),
  },
  { id: "domain", header: "Domain", size: 180, cell: (r) => r.domain || dash },
  { id: "industry", header: "Industry", cell: (r) => r.industry || dash },
  { id: "city", header: "City", size: 130, cell: (r) => r.city || dash },
  {
    id: "owner",
    header: "Owner",
    cell: (r) => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <UserAvatar name={r.owner?.name} size="sm" />
        <span className="truncate">{r.owner?.name ?? "No owner"}</span>
      </span>
    ),
  },
  {
    id: "contactCount",
    header: "Contacts",
    sortable: true,
    size: 110,
    cell: (r) => <span className="num">{r.contactCount}</span>,
  },
  {
    id: "openDealCount",
    header: "Open deals",
    size: 160,
    cell: (r) =>
      r.openDealCount ? (
        <span className="inline-flex items-center gap-2">
          <span className="num">{r.openDealCount}</span>
          <Money amount={r.openDealAmount} compact className="text-muted-foreground" />
        </span>
      ) : (
        dash
      ),
  },
  {
    id: "createdAt",
    header: "Created",
    sortable: true,
    cell: (r) => <RelativeTime value={r.createdAt} />,
  },
  {
    id: "updatedAt",
    header: "Updated",
    sortable: true,
    cell: (r) => <RelativeTime value={r.updatedAt} />,
  },
];

const EMPTY_TEXT: Record<string, string> = {
  mine: "No companies are assigned to you.",
  recent: "No companies were added in the last 7 days.",
};

export function CompaniesPage() {
  const [state, set] = useListUrlState(companiesSearchSchema);
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const { users } = useSession();
  const createCompany = useCreateCompanyDialog();
  const [saveOpen, setSaveOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const params = useMemo(() => toApiParams(state), [state]);
  const list = useCompanies(params);
  const count = useCompaniesCount(params);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  const industries = useCompanyIndustries();
  const duplicates = useCompanyDuplicatesCount({}, isAdmin);
  const savedViews = useSavedViews("companies");
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

  const views: CompanyView[] = [
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

  // Selected values stay listed even if no live company uses them any more.
  const industryOptions = [
    ...new Set([...(industries.data?.data ?? []), ...(state.industry ?? [])]),
  ];
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
      id: "industry",
      label: "Industry",
      type: "multi",
      options: industryOptions.map((value) => ({ value, label: value })),
    },
    {
      id: "hasDomain",
      label: "Domain",
      type: "boolean",
      trueLabel: "Has a domain",
      falseLabel: "No domain",
    },
    { id: "created", label: "Created", type: "dateRange" },
  ];

  const hasFilters = Object.keys(toSavedViewBody(state).filters).length > 0;
  const emptyState = !hasFilters ? (
    <EmptyState
      icon={Building2}
      title="No companies yet"
      text="Companies are created automatically from your contacts, or create one now."
      action={<Button onClick={createCompany.open}>Create company</Button>}
    />
  ) : (
    <EmptyState
      icon={Building2}
      title="No companies match"
      text={EMPTY_TEXT[activeId] ?? "Try other filters or a different search."}
      action={
        <Button variant="outline" onClick={() => applyView("all")}>
          Show all companies
        </Button>
      }
    />
  );
  const openDuplicates = duplicates.data?.count ?? 0;

  return (
    <div className="pb-24">
      <PageHeader
        title="Companies"
        count={count.data?.count ?? null}
        actions={
          isAdmin && (
            <Button variant="outline" asChild>
              <Link to="/companies/duplicates">
                <CopyCheck /> Review duplicates
                {duplicates.data ? ` (${openDuplicates} open)` : ""}
              </Link>
            </Button>
          )
        }
        primaryAction={<Button onClick={createCompany.open}>Create company</Button>}
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
              placeholder="Search name or domain"
              aria-label="Search companies"
              className="pl-8"
            />
          </div>
          <FilterBar
            filters={quickFilters}
            values={toFilterValues(state)}
            onChange={(values) => void set(fromFilterValues(values))}
          />
        </div>
        <DataTable<CompanyListItem>
          label="Companies"
          data={rows}
          columns={COMPANY_COLUMNS}
          getRowId={(r) => r.id}
          getRowHref={(r) => `/companies/${r.id}`}
          onRowClick={(r) =>
            void navigate({ to: "/companies/$companyId", params: { companyId: r.id } })
          }
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
      </div>

      <ViewNameDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="Save view"
        showShare
        saving={createView.isPending}
        onSave={(value) =>
          void createView
            .mutateAsync({ object: "companies", ...value, ...toSavedViewBody(state) })
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
                ? "It is shared, so it disappears for everyone in this workspace. Companies are not affected."
                : "Companies are not affected."
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
