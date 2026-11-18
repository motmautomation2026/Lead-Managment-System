import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/crm/page-header";
import { ViewTabs } from "@/components/crm/view-tabs";
import { DataTable } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { CONTACT_COLUMNS } from "@/features/contacts/contact-columns";
import { DEFAULT_COLUMNS as CONTACT_DEFAULT_COLUMNS } from "@/features/contacts/contacts-search";
import { COMPANY_COLUMNS } from "@/features/companies/company-columns";
import { DEFAULT_COLUMNS as COMPANY_DEFAULT_COLUMNS } from "@/features/companies/companies-search";
import { DEAL_COLUMNS } from "@/features/deals/deal-columns";
import { DEFAULT_COLUMNS as DEAL_DEFAULT_COLUMNS } from "@/features/deals/deals-search";
import { usePrefetchRecord } from "@/features/crm/prefetch";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useListUrlState } from "@/lib/use-list-url-state";
import {
  useCompanies,
  useCompaniesCount,
  useContacts,
  useContactsCount,
  useDeals,
  useDealsCount,
} from "@/store";
import { SEARCH_MIN_CHARS } from "@/store/server-hooks";
import { searchPageSchema, type SearchTab as Tab } from "./search-schema";

/**
 * Full results for a search term (GET /search shows only 5 each): one tab per object over its
 * own list endpoint with `q`, the same scope as the palette (contacts of every lifecycle except
 * merged, deals of every status). Counts from each `/count`.
 */
export function SearchPage() {
  const [state, set] = useListUrlState(searchPageSchema);
  const [qInput, setQInput] = useState(state.q ?? "");
  const debouncedQ = useDebouncedValue(qInput, 300);
  const lastQ = useRef(debouncedQ);
  useEffect(() => {
    if (lastQ.current === debouncedQ) return;
    lastQ.current = debouncedQ;
    void set({ q: debouncedQ || undefined }, { replace: true });
  }, [debouncedQ, set]);
  // Back/Forward to another term: show it in the box.
  useEffect(() => {
    if ((state.q ?? "") !== lastQ.current) {
      lastQ.current = state.q ?? "";
      setQInput(state.q ?? "");
    }
  }, [state.q]);

  const term = (state.q ?? "").trim();
  return (
    <div className="pb-24">
      <PageHeader title="Search" />
      <div className="space-y-3 px-4 pt-4 sm:px-6">
        <div className="relative w-full sm:w-96">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Search contacts, companies and deals"
            aria-label="Search"
            data-list-search
            className="pl-8"
            autoFocus
          />
        </div>
        {term.length >= SEARCH_MIN_CHARS ? (
          <Results
            term={term}
            tab={state.tab ?? "contacts"}
            onTab={(tab) => void set({ tab: tab === "contacts" ? undefined : tab })}
          />
        ) : (
          <EmptyState
            icon={Search}
            title="Search your CRM"
            text={`Type at least ${SEARCH_MIN_CHARS} characters to search contacts, companies and deals.`}
          />
        )}
      </div>
    </div>
  );
}

function Results({ term, tab, onTab }: { term: string; tab: Tab; onTab: (tab: Tab) => void }) {
  const navigate = useNavigate();
  const prefetch = usePrefetchRecord();
  const contactParams = useMemo(() => ({ q: term, lifecycle: ["all"] }), [term]);
  const companyParams = useMemo(() => ({ q: term }), [term]);
  const dealParams = useMemo(() => ({ q: term, status: "all" as const }), [term]);
  const counts = {
    contacts: useContactsCount(contactParams).data?.count,
    companies: useCompaniesCount(companyParams).data?.count,
    deals: useDealsCount(dealParams).data?.count,
  };
  const label = (name: string, count: number | undefined) =>
    count === undefined ? name : `${name} · ${count}`;
  const views = [
    { id: "contacts", label: label("Contacts", counts.contacts) },
    { id: "companies", label: label("Companies", counts.companies) },
    { id: "deals", label: label("Deals", counts.deals) },
  ];
  const empty = (what: string) => (
    <EmptyState
      icon={Search}
      title={`No ${what} match “${term}”`}
      text="Try another tab or term."
    />
  );

  return (
    <div className="space-y-3">
      <div className="border-b">
        <ViewTabs views={views} activeId={tab} onChange={(id) => onTab(id as Tab)} />
      </div>
      <div className="flex justify-end">
        {tab === "contacts" && (
          <Link to="/contacts" search={contactParams} className="type-small hover:underline">
            Open in Contacts list
          </Link>
        )}
        {tab === "companies" && (
          <Link to="/companies" search={companyParams} className="type-small hover:underline">
            Open in Companies list
          </Link>
        )}
        {tab === "deals" && (
          <Link to="/deals" search={dealParams} className="type-small hover:underline">
            Open in Deals list
          </Link>
        )}
      </div>
      {tab === "contacts" && (
        <ContactResults
          params={contactParams}
          empty={empty("contacts")}
          onOpen={(id) => void navigate({ to: "/contacts/$contactId", params: { contactId: id } })}
          onIntent={(id) => prefetch("contact", id)}
        />
      )}
      {tab === "companies" && (
        <CompanyResults
          params={companyParams}
          empty={empty("companies")}
          onOpen={(id) => void navigate({ to: "/companies/$companyId", params: { companyId: id } })}
          onIntent={(id) => prefetch("company", id)}
        />
      )}
      {tab === "deals" && (
        <DealResults
          params={dealParams}
          empty={empty("deals")}
          onOpen={(id) => void navigate({ to: "/deals/$dealId", params: { dealId: id } })}
          onIntent={(id) => prefetch("deal", id)}
        />
      )}
    </div>
  );
}

interface ResultProps<P> {
  params: P;
  empty: React.ReactNode;
  onOpen: (id: string) => void;
  onIntent: (id: string) => void;
}

function ContactResults({
  params,
  empty,
  onOpen,
  onIntent,
}: ResultProps<{ q: string; lifecycle: string[] }>) {
  const list = useContacts(params);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  return (
    <DataTable
      label="Contacts"
      data={rows}
      columns={CONTACT_COLUMNS}
      visibleColumns={CONTACT_DEFAULT_COLUMNS}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/contacts/${r.id}`}
      onRowClick={(r) => onOpen(r.id)}
      onRowIntent={(r) => onIntent(r.id)}
      hasNextPage={list.hasNextPage}
      isFetchingNextPage={list.isFetchingNextPage}
      onLoadMore={() => void list.fetchNextPage()}
      isLoading={list.isLoading}
      error={list.error}
      onRetry={() => void list.refetch()}
      emptyState={empty}
    />
  );
}

function CompanyResults({ params, empty, onOpen, onIntent }: ResultProps<{ q: string }>) {
  const list = useCompanies(params);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  return (
    <DataTable
      label="Companies"
      data={rows}
      columns={COMPANY_COLUMNS}
      visibleColumns={COMPANY_DEFAULT_COLUMNS}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/companies/${r.id}`}
      onRowClick={(r) => onOpen(r.id)}
      onRowIntent={(r) => onIntent(r.id)}
      hasNextPage={list.hasNextPage}
      isFetchingNextPage={list.isFetchingNextPage}
      onLoadMore={() => void list.fetchNextPage()}
      isLoading={list.isLoading}
      error={list.error}
      onRetry={() => void list.refetch()}
      emptyState={empty}
    />
  );
}

function DealResults({
  params,
  empty,
  onOpen,
  onIntent,
}: ResultProps<{ q: string; status: "all" }>) {
  const list = useDeals(params);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  return (
    <DataTable
      label="Deals"
      data={rows}
      columns={DEAL_COLUMNS}
      visibleColumns={DEAL_DEFAULT_COLUMNS}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/deals/${r.id}`}
      onRowClick={(r) => onOpen(r.id)}
      onRowIntent={(r) => onIntent(r.id)}
      hasNextPage={list.hasNextPage}
      isFetchingNextPage={list.isFetchingNextPage}
      onLoadMore={() => void list.fetchNextPage()}
      isLoading={list.isLoading}
      error={list.error}
      onRetry={() => void list.refetch()}
      emptyState={empty}
    />
  );
}
