import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Building2, CopyCheck, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/crm/page-header";
import { FilterBar } from "@/components/crm/filter-bar";
import type { FilterDef } from "@/components/crm/filter-model";
import { DataTable } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { useCreateCompanyDialog } from "@/app/add-lead-context";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useListUrlState } from "@/lib/use-list-url-state";
import { useListPrefs } from "@/lib/list-prefs";
import {
  useCompanies,
  useCompaniesCount,
  useCompanyDuplicatesCount,
  useCompanyIndustries,
  useIsAdmin,
  useSession,
} from "@/store";
import type { CompanyListItem } from "@/types";
import {
  DEFAULT_COLUMNS,
  NO_FILTERS,
  companiesSearchSchema,
  fromFilterValues,
  parseSort,
  toApiParams,
  toFilterValues,
  COMPANY_VIEW_SPEC,
} from "./companies-search";
import { usePrefetchRecord } from "@/features/crm/prefetch";
import { SavedViewTabs } from "@/features/crm/saved-view-tabs";
import { toSavedViewBody } from "@/features/crm/saved-views";
import { useListViews } from "@/features/crm/use-list-views";
import { COMPANY_COLUMNS } from "./company-columns";

const EMPTY_TEXT: Record<string, string> = {
  mine: "No companies are assigned to you.",
  recent: "No companies were added in the last 7 days.",
};

const RecordPeek = lazy(() => import("@/features/crm/record-peek"));

export function CompaniesPage() {
  const [state, set] = useListUrlState(companiesSearchSchema);
  const prefs = useListPrefs("companies", state.columns, DEFAULT_COLUMNS);
  const navigate = useNavigate();
  const prefetch = usePrefetchRecord();
  const isAdmin = useIsAdmin();
  const { users } = useSession();
  const createCompany = useCreateCompanyDialog();

  const params = useMemo(() => toApiParams(state), [state]);
  const list = useCompanies({ ...params, limit: prefs.limit });
  const count = useCompaniesCount(params);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  const industries = useCompanyIndustries();
  const duplicates = useCompanyDuplicatesCount({}, isAdmin);

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

  const viewsCtl = useListViews(COMPANY_VIEW_SPEC, state, set, (next) => {
    setQInput(next.q ?? "");
    lastQ.current = next.q ?? "";
  });
  const activeId = viewsCtl.activeId;
  const applyView = viewsCtl.apply;

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

  const hasFilters = Object.keys(toSavedViewBody(state, toApiParams).filters).length > 0;
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
        tabs={<SavedViewTabs controller={viewsCtl} />}
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
              data-list-search
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
          onRowIntent={(r) => prefetch("company", r.id)}
          onRowClick={(r) => void set({ peek: r.id })}
          sort={parseSort(state.sort)}
          onSortChange={(s) => void set({ sort: `${s.field}:${s.dir}` })}
          visibleColumns={prefs.columns}
          onColumnsChange={(columns) => {
            prefs.rememberColumns(columns);
            void set({ columns });
          }}
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
      </div>
      {state.peek && (
        <Suspense fallback={null}>
          <RecordPeek
            type="company"
            id={state.peek}
            onClose={() => void set({ peek: undefined })}
          />
        </Suspense>
      )}
    </div>
  );
}
