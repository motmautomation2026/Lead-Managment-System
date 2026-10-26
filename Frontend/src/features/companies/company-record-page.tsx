import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ChevronDown, Globe, Handshake, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/crm/page-header";
import { RecordLayout } from "@/components/crm/record-layout";
import { DataTable, type DataTableColumn, type SortState } from "@/components/crm/data-table";
import { AssociationCard } from "@/components/crm/association-card";
import { EmptyState } from "@/components/crm/empty-state";
import { UserAvatar } from "@/components/crm/user-avatar";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";
import { useAddLead } from "@/app/add-lead-context";
import { CONTACT_COLUMNS } from "@/features/contacts/contact-columns";
import { ActivityFeed } from "@/features/crm/activity-feed";
import { BackendError } from "@/lib/backend-client";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/labels";
import {
  messageFromError,
  useCompany,
  useCompanyContacts,
  useCompanyDeals,
  useCompanyDuplicates,
  useIsAdmin,
  useSession,
  useUpdateCompany,
} from "@/store";
import type { CompanyDetail, DealListItem } from "@/types";
import { useCreateDealDialog } from "@/app/add-lead-context";
import { DealStagePill } from "@/features/deals/deal-stage-pill";
import { CompanyAbout } from "./company-about";
import { NO_OWNER } from "./company-helpers";
import { MergeCompanyDialog } from "./merge-company-dialog";
import { REASON_LABEL } from "./duplicates-search";
import { RecordLink } from "@/features/crm/record-link";
import { usePrefetchRecord } from "@/features/crm/prefetch";

const dash = <span className="text-muted-foreground">–</span>;
const CONTACT_TAB_COLUMNS = [
  "name",
  "email",
  "phone",
  "owner",
  "leadStatus",
  "openDeal",
  "lastActivityAt",
];
const DEFAULT_CONTACT_SORT: SortState = { field: "createdAt", dir: "desc" };
const DEFAULT_DEAL_SORT: SortState = { field: "updatedAt", dir: "desc" };
const sortParam = (s: SortState) => `${s.field}:${s.dir}`;
const isOpenDeal = (d: DealListItem) => d.stage !== "won" && d.stage !== "lost";

const DEAL_COLUMNS: DataTableColumn<DealListItem>[] = [
  {
    id: "name",
    header: "Deal",
    sortable: true,
    size: 220,
    cell: (d) => <span className="truncate font-medium">{d.name}</span>,
  },
  { id: "stage", header: "Stage", size: 170, cell: (d) => <DealStagePill stage={d.stage} /> },
  {
    id: "amount",
    header: "Amount",
    sortable: true,
    size: 120,
    cell: (d) => (d.amount === null ? dash : <Money amount={d.amount} currency={d.currency} />),
  },
  {
    id: "expectedCloseDate",
    header: "Close date",
    sortable: true,
    size: 120,
    cell: (d) => (d.expectedCloseDate ? fmtDate(`${d.expectedCloseDate}T12:00:00+05:30`) : dash),
  },
  { id: "owner", header: "Owner", cell: (d) => d.owner?.name ?? dash },
  { id: "contact", header: "Contact", cell: (d) => d.contact.name || dash },
];

/** HubSpot-style company record, fetched by id. A merged company points to the one it went into. */
export function CompanyRecordPage({ companyId }: { companyId: string }) {
  const query = useCompany(companyId);
  if (query.isLoading) {
    return (
      <div className="p-6">
        <LoadingBlock label="Loading company…" />
      </div>
    );
  }
  if (!query.data) {
    return query.error instanceof BackendError && query.error.status === 404 ? (
      <EmptyState
        title="Company not found"
        text="It may have been deleted, or it belongs to another workspace."
        action={
          <Button asChild variant="outline">
            <Link to="/companies">Back to companies</Link>
          </Button>
        }
      />
    ) : (
      <div className="p-6">
        <ErrorBlock error={query.error} />
      </div>
    );
  }
  if (query.data.mergedIntoCompanyId)
    return <MergedNotice company={query.data} targetId={query.data.mergedIntoCompanyId} />;
  return <CompanyRecord key={query.data.id} company={query.data} />;
}

function MergedNotice({ company, targetId }: { company: CompanyDetail; targetId: string }) {
  const target = useCompany(targetId);
  const name = target.data?.name ?? "another company";
  return (
    <EmptyState
      title={`“${company.name}” was merged into ${target.data ? `“${name}”` : name}`}
      text="Its contacts and deals now belong to that company."
      action={
        <Button asChild>
          <RecordLink type="company" id={targetId}>
            Open {target.data ? name : "the company"}
          </RecordLink>
        </Button>
      }
    />
  );
}

function CompanyRecord({ company }: { company: CompanyDetail }) {
  const id = company.id;
  const navigate = useNavigate();
  const prefetch = usePrefetchRecord();
  const isAdmin = useIsAdmin();
  const { users } = useSession();
  const update = useUpdateCompany();
  const addContact = useAddLead();
  const [mergeOpen, setMergeOpen] = useState(false);
  const createDeal = useCreateDealDialog();
  const openCreateDeal = () => createDeal.open({ companyId: id, stay: true });
  const [contactSort, setContactSort] = useState(DEFAULT_CONTACT_SORT);
  const [dealSort, setDealSort] = useState(DEFAULT_DEAL_SORT);

  const contacts = useCompanyContacts(id, { sort: sortParam(contactSort) });
  const deals = useCompanyDeals(id, { status: "all", sort: sortParam(dealSort) });
  // Right panel + Overview: their own small lists (independent of the tabs' sort).
  const topContacts = useCompanyContacts(id, { sort: "lastActivityAt:desc", limit: 5 });
  const openDeals = useCompanyDeals(id, { status: "open", sort: "updatedAt:desc", limit: 5 });
  const duplicates = useCompanyDuplicates({ companyId: id }, isAdmin);
  const contactRows = contacts.data?.pages.flatMap((p) => p.data) ?? [];
  const dealRows = deals.data?.pages.flatMap((p) => p.data) ?? [];
  const topContactRows = topContacts.data?.pages[0]?.data ?? [];
  const openDealRows = openDeals.data?.pages[0]?.data ?? [];
  const duplicateRows = duplicates.data?.pages.flatMap((p) => p.data) ?? [];

  const setOwner = (value: string) =>
    update
      .mutateAsync({ id, input: { ownerId: value === NO_OWNER ? null : value } })
      .then(() => toast.success("Owner updated"))
      .catch((error: unknown) => toast.error(messageFromError(error)));

  const heading = (
    <div className="flex min-w-0 items-start gap-3">
      <UserAvatar name={company.name} className="size-12 rounded-lg text-base" />
      <div className="min-w-0">
        <h1 className="type-page-title break-words">{company.name}</h1>
        <p className="flex flex-wrap items-center gap-x-2 type-body text-muted-foreground">
          {company.domain && (
            <a
              href={`https://${company.domain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <Globe className="size-3.5" /> {company.domain}
            </a>
          )}
          <span>{[company.industry, company.city].filter(Boolean).join(" · ") || "–"}</span>
        </p>
        <div className="mt-2">
          <Select value={company.owner?.id ?? NO_OWNER} onValueChange={(v) => void setOwner(v)}>
            <SelectTrigger className="h-7 w-auto gap-1.5 text-xs" aria-label="Company owner">
              <UserAvatar name={company.owner?.name} size="sm" className="size-5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_OWNER}>No owner</SelectItem>
              {users
                .filter((u) => u.active || u.id === company.owner?.id)
                .map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );

  const actions = (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => addContact.open({ company: company.name })}
      >
        <UserPlus /> Add contact
      </Button>
      <Button size="sm" variant="outline" onClick={openCreateDeal}>
        <Handshake /> Create deal
      </Button>
      {isAdmin && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              More <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setMergeOpen(true)}>
              Merge into another company…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );

  const fact = (title: string, value: React.ReactNode) => (
    <Card className="p-4">
      <div className="type-label">{title}</div>
      <div className="mt-1 type-section-title">{value}</div>
    </Card>
  );
  const overview = (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {fact("Contacts", <span className="num">{company.contactCount}</span>)}
        {fact(
          "Open deals",
          <span className="inline-flex items-baseline gap-2">
            <span className="num">{company.openDealCount}</span>
            <Money
              amount={company.openDealAmount}
              compact
              className="type-body text-muted-foreground"
            />
          </span>,
        )}
        {fact(
          "Last activity",
          company.lastActivityAt ? (
            <RelativeTime value={company.lastActivityAt} className="type-body" />
          ) : (
            dash
          ),
        )}
      </div>
      <section className="space-y-2">
        <h2 className="type-section-title">Recent activity</h2>
        <ActivityFeed companyId={id} limit={5} />
      </section>
      <section className="space-y-2">
        <h2 className="type-section-title">Open deals</h2>
        {openDealRows.length === 0 ? (
          <p className="type-body text-muted-foreground">No open deals.</p>
        ) : (
          <Card className="divide-y p-0">
            {openDealRows.map((d) => (
              <div
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              >
                <RecordLink
                  type="deal"
                  id={d.id}
                  className="min-w-0 truncate type-body font-medium hover:underline"
                >
                  {d.name}
                </RecordLink>
                <span className="inline-flex items-center gap-2">
                  <StatusBadge value={d.stage} />
                  <Money amount={d.amount} currency={d.currency} compact />
                </span>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );

  const contactsTab = (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={() => addContact.open({ company: company.name })}
        >
          <UserPlus /> Add contact
        </Button>
      </div>
      <DataTable
        label="Company contacts"
        data={contactRows}
        columns={CONTACT_COLUMNS}
        visibleColumns={CONTACT_TAB_COLUMNS}
        getRowId={(r) => r.id}
        getRowHref={(r) => `/contacts/${r.id}`}
        onRowIntent={(r) => prefetch("contact", r.id)}
        onRowClick={(r) =>
          void navigate({ to: "/contacts/$contactId", params: { contactId: r.id } })
        }
        sort={contactSort}
        onSortChange={setContactSort}
        hasNextPage={contacts.hasNextPage}
        isFetchingNextPage={contacts.isFetchingNextPage}
        onLoadMore={() => void contacts.fetchNextPage()}
        isLoading={contacts.isLoading}
        error={contacts.error}
        onRetry={() => void contacts.refetch()}
        className="max-h-[60dvh]"
        emptyState={<EmptyState title="No contacts at this company yet" />}
      />
    </div>
  );

  const dealsTab = (
    <DataTable
      label="Company deals"
      data={dealRows}
      columns={DEAL_COLUMNS}
      getRowId={(d) => d.id}
      getRowHref={(d) => `/deals/${d.id}`}
      onRowIntent={(d) => prefetch("deal", d.id)}
      onRowClick={(d) => void navigate({ to: "/deals/$dealId", params: { dealId: d.id } })}
      sort={dealSort}
      onSortChange={setDealSort}
      hasNextPage={deals.hasNextPage}
      isFetchingNextPage={deals.isFetchingNextPage}
      onLoadMore={() => void deals.fetchNextPage()}
      isLoading={deals.isLoading}
      error={deals.error}
      onRetry={() => void deals.refetch()}
      className="max-h-[60dvh]"
      emptyState={<EmptyState title="No deals yet" text="Create a deal for one of its contacts." />}
    />
  );

  const right = (
    <>
      <AssociationCard
        title="Contacts"
        count={company.contactCount}
        onAdd={() => addContact.open({ company: company.name })}
        emptyText="No contacts yet."
        items={topContactRows.map((c) => ({
          id: c.id,
          title: (
            <RecordLink type="contact" id={c.id} className="hover:underline">
              {c.name || "Unnamed contact"}
            </RecordLink>
          ),
          subtitle: [c.jobTitle, c.email].filter(Boolean).join(" · ") || null,
          meta: <StatusBadge value={c.leadStatus} />,
        }))}
      />
      {company.contactCount > 5 && (
        <Link
          to="/contacts"
          search={{ companyId: id }}
          className="-mt-2 block px-1 type-small font-medium text-primary hover:underline"
        >
          View all {company.contactCount} contacts
        </Link>
      )}
      <AssociationCard
        title="Open deals"
        count={company.openDealCount}
        onAdd={openCreateDeal}
        emptyText="No open deals."
        items={openDealRows.map((d) => ({
          id: d.id,
          title: (
            <RecordLink type="deal" id={d.id} className="hover:underline">
              {d.name}
            </RecordLink>
          ),
          subtitle: label(d.stage),
          meta: <Money amount={d.amount} currency={d.currency} compact />,
        }))}
      />
      {company.openDealCount > 0 && (
        <p className="-mt-2 px-1 type-small text-muted-foreground">
          Open total <Money amount={company.openDealAmount} compact />
        </p>
      )}
      {isAdmin && (
        <AssociationCard
          title="Possible duplicates"
          count={duplicateRows.length}
          emptyText="No open duplicate suggestions."
          items={duplicateRows.map((d) => {
            const other = d.companyB ? (d.companyA.id === id ? d.companyB : d.companyA) : null;
            return {
              id: d.id,
              title: other ? other.name : (d.contact?.name ?? "A contact"),
              subtitle: other
                ? REASON_LABEL[d.reason]
                : `Contact says “${d.observedName ?? d.observedDomain ?? "?"}”`,
              meta: (
                <Link
                  to="/companies/duplicates"
                  className="type-small font-medium text-primary hover:underline"
                >
                  Review
                </Link>
              ),
            };
          })}
        />
      )}
    </>
  );

  return (
    <div className="pb-10">
      <PageHeader title={company.name} heading={heading} actions={actions} />
      <RecordLayout
        left={<CompanyAbout company={company} />}
        tabs={[
          { id: "overview", label: "Overview", content: overview },
          { id: "activity", label: "Activity", content: <ActivityFeed companyId={id} /> },
          { id: "contacts", label: "Contacts", content: contactsTab },
          { id: "deals", label: "Deals", content: dealsTab },
        ]}
        defaultTab="overview"
        right={right}
        rightLabel="Related"
      />
      {isAdmin && (
        <MergeCompanyDialog company={company} open={mergeOpen} onOpenChange={setMergeOpen} />
      )}
    </div>
  );
}
