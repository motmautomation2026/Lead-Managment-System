import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ChevronDown, Globe, Handshake, Plus, StickyNote, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { RecordShell, type RailCard } from "@/components/crm/record-shell";
import { StatusPill } from "@/components/crm/status-pill";
import { AssociationCard } from "@/components/crm/association-card";
import { EmptyState } from "@/components/crm/empty-state";
import { UserAvatar } from "@/components/crm/user-avatar";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";
import { useAddLead } from "@/app/add-lead-context";
import { ActivityFeed } from "@/features/crm/activity-feed";
import { RecordBreadcrumb } from "@/features/crm/record-breadcrumb";
import { RecordComposer } from "@/features/crm/record-composer";
import { BackendError } from "@/lib/backend-client";
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
import type { CompanyDetail } from "@/types";
import { useCreateDealDialog } from "@/app/add-lead-context";
import { CompanyAbout } from "./company-about";
import { NO_OWNER } from "./company-helpers";
import { MergeCompanyDialog } from "./merge-company-dialog";
import { REASON_LABEL } from "./duplicates-search";
import { RecordLink } from "@/features/crm/record-link";
import { useRememberRecent } from "@/features/crm/recent";
import { RecordWorkCards } from "@/features/work/record-work-cards";

/** HubSpot-style company record, fetched by id. A merged company points to the one it went into. */
export function CompanyRecordPage({ companyId }: { companyId: string }) {
  const query = useCompany(companyId);
  useRememberRecent(
    "company",
    query.data && !query.data.mergedIntoCompanyId ? query.data.id : undefined,
    query.data?.name ?? "",
  );
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
  const isAdmin = useIsAdmin();
  const { users } = useSession();
  const update = useUpdateCompany();
  const addContact = useAddLead();
  const [mergeOpen, setMergeOpen] = useState(false);
  const createDeal = useCreateDealDialog();
  const openCreateDeal = () => createDeal.open({ companyId: id, stay: true });

  // Rail lists: the first 5 of each; "View all" opens the list filtered by this company.
  const topContacts = useCompanyContacts(id, { sort: "lastActivityAt:desc", limit: 5 });
  const openDeals = useCompanyDeals(id, { status: "open", sort: "updatedAt:desc", limit: 5 });
  const duplicates = useCompanyDuplicates({ companyId: id }, isAdmin);
  const topContactRows = topContacts.data?.pages[0]?.data ?? [];
  const openDealRows = openDeals.data?.pages[0]?.data ?? [];
  const duplicateRows = duplicates.data?.pages.flatMap((p) => p.data) ?? [];

  const setOwner = (value: string) =>
    update
      .mutateAsync({ id, input: { ownerId: value === NO_OWNER ? null : value } })
      .then(() => toast.success("Owner updated"))
      .catch((error: unknown) => toast.error(messageFromError(error)));

  const focusNote = () =>
    document.querySelector<HTMLTextAreaElement>('[aria-label="New note"]')?.focus();

  const actions = (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => addContact.open({ company: company.name })}
      >
        <UserPlus /> Add contact
      </Button>
      <Button size="sm" variant="outline" onClick={focusNote}>
        <StickyNote /> Note
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            More <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={openCreateDeal}>
            <Handshake /> Create deal
          </DropdownMenuItem>
          {isAdmin && (
            <DropdownMenuItem onSelect={() => setMergeOpen(true)}>
              Merge into another company…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 items-start gap-3">
        <UserAvatar name={company.name} className="size-10 rounded-lg text-sm" />
        <div className="min-w-0">
          <h1 className="type-page-title truncate">{company.name}</h1>
          <p className="flex flex-wrap items-center gap-x-2 type-small text-muted-foreground">
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
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
            <StatusPill tone="neutral">
              {company.contactCount} contact{company.contactCount === 1 ? "" : "s"}
            </StatusPill>
            <StatusPill tone={company.openDealCount ? "info" : "neutral"}>
              {company.openDealCount} open deal{company.openDealCount === 1 ? "" : "s"}
              {company.openDealCount > 0 && (
                <>
                  {" · "}
                  <Money amount={company.openDealAmount} compact />
                </>
              )}
            </StatusPill>
            {company.lastActivityAt && (
              <span className="type-small text-muted-foreground">
                Last activity <RelativeTime value={company.lastActivityAt} />
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{actions}</div>
    </div>
  );

  const rail: RailCard[] = [
    { id: "about", title: "About", content: <CompanyAbout company={company} /> },
    {
      id: "contacts",
      title: "Contacts",
      badge: company.contactCount,
      action: (
        <Button
          size="sm"
          variant="ghost"
          aria-label="Add contact to this company"
          onClick={() => addContact.open({ company: company.name })}
        >
          <Plus /> Add
        </Button>
      ),
      content: (
        <AssociationCard
          bare
          title="Contacts"
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
          footer={
            company.contactCount > 0 && (
              <Link
                to="/contacts"
                search={{ companyId: id }}
                className="type-small font-medium text-primary hover:underline"
              >
                View all {company.contactCount} contacts
              </Link>
            )
          }
        />
      ),
    },
    {
      id: "deals",
      title: "Open deals",
      badge: company.openDealCount,
      action: (
        <Button size="sm" variant="ghost" aria-label="Create deal" onClick={openCreateDeal}>
          <Plus /> Deal
        </Button>
      ),
      content: (
        <AssociationCard
          bare
          title="Open deals"
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
          footer={
            <Link
              to="/deals"
              search={{ companyId: id, status: "all" }}
              className="type-small font-medium text-primary hover:underline"
            >
              All deals of this company
            </Link>
          }
        />
      ),
    },
    {
      id: "work",
      title: "Tasks, meetings & proposals",
      content: <RecordWorkCards companyId={id} bare />,
    },
    ...(isAdmin
      ? [
          {
            id: "duplicates",
            title: "Possible duplicates",
            badge: duplicateRows.length,
            defaultOpen: false,
            content: (
              <AssociationCard
                bare
                title="Possible duplicates"
                emptyText="No open duplicate suggestions."
                items={duplicateRows.map((d) => {
                  const other = d.companyB
                    ? d.companyA.id === id
                      ? d.companyB
                      : d.companyA
                    : null;
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
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <RecordShell
        railKey="company"
        breadcrumb={<RecordBreadcrumb list="/companies" label="Companies" name={company.name} />}
        header={header}
        main={
          <>
            <RecordComposer companyId={id} canCall={false} />
            <ActivityFeed companyId={id} />
          </>
        }
        rail={rail}
      />
      {isAdmin && (
        <MergeCompanyDialog company={company} open={mergeOpen} onOpenChange={setMergeOpen} />
      )}
    </>
  );
}
