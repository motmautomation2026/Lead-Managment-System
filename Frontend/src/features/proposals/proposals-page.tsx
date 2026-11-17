import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileText, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PageHeader } from "@/components/crm/page-header";
import { FilterBar } from "@/components/crm/filter-bar";
import type { FilterDef } from "@/components/crm/filter-model";
import { DataTable } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { Money } from "@/components/crm/money";
import { PropertyList } from "@/components/crm/property-list";
import { RelativeTime } from "@/components/crm/relative-time";
import { StatusPill } from "@/components/crm/status-pill";
import { CompanyPicker } from "@/features/companies/company-picker";
import { SavedViewTabs } from "@/features/crm/saved-view-tabs";
import { toSavedViewBody } from "@/features/crm/saved-views";
import { useListViews } from "@/features/crm/use-list-views";
import { ProposalStatusDialog } from "@/features/work/proposal-status-dialog";
import { ProposalValidUntil } from "@/features/work/proposal-valid-until";
import { ViewDocumentButton } from "@/features/work/proposal-document";
import { RefLink } from "@/features/work/ref-link";
import { ContactFilter, DealFilterChip } from "@/features/work/work-filters";
import { label } from "@/lib/labels";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useListUrlState } from "@/lib/use-list-url-state";
import { useListPrefs } from "@/lib/list-prefs";
import {
  useCompany,
  useCreateProposal,
  useIsAdmin,
  useProposalCount,
  useProposalList,
  useProposalSummary,
  useSession,
} from "@/store";
import { PROPOSAL_STATUSES, type ProposalListItem } from "@/types";
import { SendProposalDialog } from "./components/send-proposal-dialog";
import { PROPOSAL_COLUMNS } from "./proposal-columns";
import { ProposalSendIcons } from "./proposal-send-icons";
import {
  DEFAULT_COLUMNS,
  PROPOSAL_STATUS_TONE,
  PROPOSAL_VIEW_SPEC,
  fromFilterValues,
  parseSort,
  proposalsSearchSchema,
  toApiParams,
  toFilterValues,
  toSummaryParams,
} from "./proposals-search";

const EMPTY_TEXT: Record<string, string> = {
  open: "No open proposals.",
  awaiting: "No proposals are waiting for a decision.",
  won: "No accepted proposals yet.",
  lost: "No lost proposals.",
};

export function ProposalsPage() {
  const [state, set] = useListUrlState(proposalsSearchSchema);
  const prefs = useListPrefs("proposals", state.columns, DEFAULT_COLUMNS);
  const { users, currentUser } = useSession();
  const isAdmin = useIsAdmin();
  const params = useMemo(() => toApiParams(state), [state]);
  // A bare /proposals is rewritten to Open first (useListViews); don't fetch "all" meanwhile.
  const landing = Object.keys(state).length === 0;
  const list = useProposalList({ ...params, limit: prefs.limit }, !landing);
  const count = useProposalCount(params, !landing);
  const summary = useProposalSummary(useMemo(() => toSummaryParams(state), [state]));
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  const filterCompany = useCompany(state.companyId);
  const create = useCreateProposal();

  const [qInput, setQInput] = useState(state.q ?? "");
  const debouncedQ = useDebouncedValue(qInput, 300);
  const lastQ = useRef(debouncedQ);
  useEffect(() => {
    if (lastQ.current === debouncedQ) return;
    lastQ.current = debouncedQ;
    void set({ q: debouncedQ || undefined }, { replace: true });
  }, [debouncedQ, set]);

  const viewsCtl = useListViews(PROPOSAL_VIEW_SPEC, state, set, (next) => {
    setQInput(next.q ?? "");
    lastQ.current = next.q ?? "";
  });

  const [newOpen, setNewOpen] = useState(false);
  const [sheetId, setSheetId] = useState<string | null>(null);
  // The Sheet follows the list row, so it shows send-status updates from the polling.
  const sheet = rows.find((r) => r.id === sheetId) ?? null;
  const [statusFor, setStatusFor] = useState<ProposalListItem | null>(null);

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
      options: PROPOSAL_STATUSES.map((s) => ({ value: s, label: label(s) })),
    },
    { id: "updated", label: "Updated", type: "dateRange" },
  ];

  const hasFilters = Object.keys(toSavedViewBody(state, toApiParams).filters).length > 0;
  const newButton = <Button onClick={() => setNewOpen(true)}>New proposal</Button>;
  const stats = summary.data;

  return (
    <div className="pb-24">
      <PageHeader
        title="Proposals"
        count={count.data?.count ?? null}
        primaryAction={newButton}
        tabs={<SavedViewTabs controller={viewsCtl} />}
      />
      <div className="space-y-3 px-4 pt-4 sm:px-6">
        <dl className="grid grid-cols-3 gap-2 sm:max-w-xl" aria-label="Proposal summary">
          <Stat label="Open" value={stats ? String(stats.openCount) : "–"} />
          <Stat label="Sent" value={stats ? String(stats.sentCount) : "–"} />
          <Stat
            label="Open pipeline"
            value={stats ? <Money amount={stats.openValue} compact /> : "–"}
          />
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search title or contact"
              aria-label="Search proposals"
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
        <DataTable<ProposalListItem>
          label="Proposals"
          data={rows}
          columns={PROPOSAL_COLUMNS}
          getRowId={(r) => r.id}
          onRowClick={(r) => setSheetId(r.id)}
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
          emptyState={
            <EmptyState
              icon={FileText}
              title={hasFilters ? "No proposals here" : "No proposals yet"}
              text={EMPTY_TEXT[viewsCtl.activeId] ?? "Try other filters or a different search."}
              action={newButton}
            />
          }
        />
      </div>

      <Sheet open={Boolean(sheet)} onOpenChange={(open) => !open && setSheetId(null)}>
        <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
          {sheet && (
            <>
              <SheetHeader className="border-b">
                <SheetTitle className="pr-6">{sheet.title}</SheetTitle>
                <SheetDescription>
                  <StatusPill tone={PROPOSAL_STATUS_TONE[sheet.status]}>
                    {label(sheet.status)}
                  </StatusPill>
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 p-4">
                <PropertyList
                  items={[
                    {
                      id: "amount",
                      label: "Amount",
                      value:
                        sheet.amount === undefined ? null : (
                          <Money amount={sheet.amount} currency={sheet.currency} />
                        ),
                    },
                    { id: "document", label: "Document", value: sheet.fileName ?? null },
                    { id: "owner", label: "Owner", value: sheet.ownerName ?? "No owner" },
                    {
                      id: "contact",
                      label: "Contact",
                      value: <RefLink type="contact" value={sheet.contact} />,
                    },
                    {
                      id: "company",
                      label: "Company",
                      value: <RefLink type="company" value={sheet.company} />,
                    },
                    {
                      id: "deal",
                      label: "Deal",
                      value: <RefLink type="deal" value={sheet.deal} />,
                    },
                    {
                      id: "sent",
                      label: "Sent",
                      value: sheet.sentDate ? <RelativeTime value={sheet.sentDate} /> : null,
                    },
                    {
                      id: "validUntil",
                      label: "Valid until",
                      value: (
                        <ProposalValidUntil
                          key={sheet.id}
                          proposal={sheet}
                          canEdit={
                            isAdmin || (Boolean(sheet.ownerId) && sheet.ownerId === currentUser?.id)
                          }
                        />
                      ),
                    },
                    {
                      id: "followUp",
                      label: "Follow-up",
                      value: sheet.followUpDate ? (
                        <RelativeTime value={sheet.followUpDate} />
                      ) : null,
                    },
                    {
                      id: "send",
                      label: "Sent via",
                      value: <ProposalSendIcons proposal={sheet} showReason />,
                    },
                    ...(sheet.lossReason
                      ? [{ id: "loss", label: "Loss reason", value: label(sheet.lossReason) }]
                      : []),
                    ...(sheet.notes ? [{ id: "notes", label: "Notes", value: sheet.notes }] : []),
                  ]}
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setStatusFor(sheet)}>
                    Change status
                  </Button>
                  <ViewDocumentButton proposal={sheet} />
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
      <ProposalStatusDialog
        key={statusFor?.id ?? "none"}
        proposal={statusFor}
        open={Boolean(statusFor)}
        onOpenChange={(open) => !open && setStatusFor(null)}
      />
      <SendProposalDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onSend={(value) =>
          create.mutateAsync({
            leadId: value.leadId,
            title: value.title,
            validUntil: value.validUntil || undefined,
            amount: value.amount ? Number(value.amount) : undefined,
            notes: value.notes || undefined,
            emailTemplateId: value.emailTemplateId,
            whatsappTemplateId: value.whatsappTemplateId,
            document: value.document,
          })
        }
      />
    </div>
  );
}

function Stat({ label: name, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <dt className="type-small text-muted-foreground">{name}</dt>
      <dd className="type-section-title num">{value}</dd>
    </div>
  );
}
