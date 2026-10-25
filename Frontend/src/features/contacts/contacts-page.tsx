import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { MoreHorizontal, Search, Sparkles, Upload, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { StatusBadge } from "@/components/common/status-badge";
import { PageHeader } from "@/components/crm/page-header";
import { ViewTabs } from "@/components/crm/view-tabs";
import { FilterBar } from "@/components/crm/filter-bar";
import type { FilterDef } from "@/components/crm/filter-model";
import { DataTable, type DataTableColumn } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { UserAvatar } from "@/components/crm/user-avatar";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";
import { useAddLead } from "@/app/add-lead-context";
import { ImportLeadsDialog } from "@/features/leads/import-leads-dialog";
import { AGENT_STATUS_LABEL, AGENT_STATUS_TONE } from "@/features/agent/agent-labels";
import { isOverdue } from "@/lib/format";
import { label } from "@/lib/labels";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useListUrlState } from "@/lib/use-list-url-state";
import { cn } from "@/lib/utils";
import {
  messageFromError,
  useBulkContacts,
  useCompanyOptions,
  useContacts,
  useContactsCount,
  useCreateSavedView,
  useDeleteSavedView,
  useIsAdmin,
  useSavedViews,
  useSession,
  useUpdateSavedView,
} from "@/store";
import {
  LEAD_SOURCES,
  LIFECYCLE_STATES,
  PIPELINE_STAGES,
  type AgentStatus,
  type ContactListItem,
} from "@/types";
import {
  BUILT_IN_VIEWS,
  DEFAULT_COLUMNS,
  NO_FILTERS,
  contactsSearchSchema,
  fromFilterValues,
  parseSort,
  savedViewState,
  toApiParams,
  toFilterValues,
  toSavedViewBody,
  type ContactView,
} from "./contacts-search";
import { ViewNameDialog } from "./view-name-dialog";

const dash = <span className="text-muted-foreground">–</span>;

const COLUMNS: DataTableColumn<ContactListItem>[] = [
  {
    id: "name",
    header: "Name",
    sortable: true,
    hideable: false,
    size: 220,
    cell: (r) => (
      <span className="inline-flex min-w-0 items-center gap-2 font-medium">
        <UserAvatar name={r.name} size="sm" />
        <span className="truncate">{r.name}</span>
      </span>
    ),
  },
  // Plain text until the company record page lands (C3).
  { id: "company", header: "Company", sortable: true, cell: (r) => r.company?.name ?? dash },
  { id: "email", header: "Email", size: 220, cell: (r) => r.email || dash },
  { id: "phone", header: "Phone", size: 150, cell: (r) => r.phone || dash },
  {
    id: "owner",
    header: "Owner",
    cell: (r) => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <UserAvatar name={r.owner?.name} size="sm" />
        <span className="truncate">{r.owner?.name ?? "Unassigned"}</span>
      </span>
    ),
  },
  {
    id: "leadStatus",
    header: "Lead status",
    cell: (r) => <StatusBadge value={r.leadStatus} />,
  },
  {
    id: "openDeal",
    header: "Open deal",
    size: 200,
    cell: (r) =>
      r.openDeal ? (
        <span className="inline-flex items-center gap-2">
          <StatusBadge value={r.openDeal.stage} />
          <Money amount={r.openDeal.amount} currency={r.openDeal.currency} compact />
        </span>
      ) : (
        dash
      ),
  },
  {
    id: "nextAction",
    header: "Next action",
    size: 200,
    cell: (r) =>
      r.nextAction ? (
        <div className="min-w-0">
          <div className="truncate">{r.nextAction.title}</div>
          <RelativeTime
            value={r.nextAction.dueAt}
            className={cn(
              "type-small",
              isOverdue(r.nextAction.dueAt) ? "text-destructive" : "text-muted-foreground",
            )}
          />
        </div>
      ) : (
        dash
      ),
  },
  {
    id: "lastActivityAt",
    header: "Last activity",
    sortable: true,
    cell: (r) => <RelativeTime value={r.lastActivityAt} />,
  },
  {
    id: "agentStatus",
    header: "AI status",
    size: 120,
    cell: (r) =>
      r.agentStatus === "none" ? (
        dash
      ) : (
        <StatusBadge
          value={r.agentStatus}
          display={AGENT_STATUS_LABEL[r.agentStatus]}
          tone={AGENT_STATUS_TONE[r.agentStatus]}
        />
      ),
  },
  { id: "source", header: "Source", size: 130, cell: (r) => label(r.source) },
  { id: "jobTitle", header: "Job title", cell: (r) => r.jobTitle || dash },
  {
    id: "lifecycle",
    header: "Lifecycle",
    size: 140,
    cell: (r) => <StatusBadge value={r.lifecycle} />,
  },
  {
    id: "createdAt",
    header: "Created",
    sortable: true,
    cell: (r) => <RelativeTime value={r.createdAt} />,
  },
];

const options = (values: readonly string[]) =>
  values.map((value) => ({ value, label: label(value) }));

const EMPTY_TEXT: Record<string, string> = {
  mine: "No contacts are assigned to you.",
  recent: "No contacts were added in the last 7 days.",
  unassigned: "Every contact has an owner.",
};

export function ContactsPage() {
  const [state, set] = useListUrlState(contactsSearchSchema);
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const { users } = useSession();
  const createContact = useAddLead();
  const [importOpen, setImportOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const params = useMemo(() => toApiParams(state), [state]);
  const list = useContacts(params);
  const count = useContactsCount(params);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  const bulk = useBulkContacts();
  const companies = useCompanyOptions();
  const savedViews = useSavedViews("contacts");
  const createView = useCreateSavedView();
  const updateView = useUpdateSavedView();
  const deleteView = useDeleteSavedView();

  // Selection belongs to one list (filters + sort); it clears when they change.
  const listKey = JSON.stringify(params);
  const [selection, setSelection] = useState({ key: listKey, ids: [] as string[] });
  const selected = selection.key === listKey ? selection.ids : [];
  const setSelected = (ids: string[]) => setSelection({ key: listKey, ids });

  // The search box writes `q` to the URL once typing settles (only when the text changed,
  // so Back/Forward still restore older URLs).
  const [qInput, setQInput] = useState(state.q ?? "");
  const debouncedQ = useDebouncedValue(qInput, 300);
  const lastQ = useRef(debouncedQ);
  useEffect(() => {
    if (lastQ.current === debouncedQ) return;
    lastQ.current = debouncedQ;
    void set({ q: debouncedQ || undefined }, { replace: true });
  }, [debouncedQ, set]);

  const views: ContactView[] = [
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
    {
      id: "ownerId",
      label: "Owner",
      type: "multi",
      options: [
        { value: "me", label: "Me" },
        { value: "none", label: "Unassigned" },
        ...users.map((u) => ({ value: u.id, label: u.name })),
      ],
    },
    { id: "leadStatus", label: "Lead status", type: "multi", options: options(PIPELINE_STAGES) },
    {
      id: "lifecycle",
      label: "Lifecycle",
      type: "multi",
      options: [{ value: "all", label: "All (except merged)" }, ...options(LIFECYCLE_STATES)],
    },
    { id: "source", label: "Source", type: "multi", options: options(LEAD_SOURCES) },
    {
      id: "agentStatus",
      label: "AI status",
      type: "multi",
      options: (Object.keys(AGENT_STATUS_LABEL) as AgentStatus[]).map((value) => ({
        value,
        label: value === "none" ? "Not enrolled" : AGENT_STATUS_LABEL[value],
      })),
    },
    {
      id: "hasOpenDeal",
      label: "Open deal",
      type: "boolean",
      trueLabel: "Has an open deal",
      falseLabel: "No open deal",
    },
    { id: "created", label: "Created", type: "dateRange" },
  ];
  const moreFilters: FilterDef[] = [
    {
      id: "companyId",
      label: "Company",
      type: "multi",
      options: (companies.data?.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    },
    { id: "lastActivity", label: "Last activity", type: "dateRange" },
  ];

  const nameOf = (id: string) => rows.find((r) => r.id === id)?.name ?? id;
  const runBulk = async (action: "assignOwner" | "enrollAi", ownerId?: string) => {
    const verb = action === "assignOwner" ? "assigned" : "enrolled in AI";
    try {
      const results = await bulk.mutateAsync({
        ids: selected,
        action,
        ...(ownerId ? { ownerId } : {}),
      });
      const failed = results.filter((r) => !r.ok);
      const done = results.length - failed.length;
      if (failed.length === 0) {
        toast.success(`${done} contact${done === 1 ? "" : "s"} ${verb}`);
      } else {
        toast.warning(`${done} of ${results.length} ${verb}; ${failed.length} not`, {
          description: failed
            .slice(0, 5)
            .map((f) => `${nameOf(f.id)}: ${f.error ?? "failed"}`)
            .join(" · "),
        });
      }
      setSelected([]);
    } catch (error) {
      toast.error(messageFromError(error));
    }
  };

  const hasFilters = Object.keys(toSavedViewBody(state).filters).length > 0;
  const emptyState = !hasFilters ? (
    <EmptyState
      icon={Users}
      title="No contacts yet"
      text="Create a contact or import a CSV."
      action={
        <div className="flex gap-2">
          <Button onClick={createContact.open}>Create contact</Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            Import
          </Button>
        </div>
      }
    />
  ) : (
    <EmptyState
      icon={Users}
      title="No contacts match"
      text={EMPTY_TEXT[activeId] ?? "Try other filters or a different search."}
      action={
        <Button variant="outline" onClick={() => applyView("all")}>
          Show all contacts
        </Button>
      }
    />
  );

  return (
    <div className="pb-24">
      <PageHeader
        title="Contacts"
        count={count.data?.count ?? null}
        actions={
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload /> Import
          </Button>
        }
        primaryAction={<Button onClick={createContact.open}>Create contact</Button>}
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
              placeholder="Search name, company, email, phone"
              aria-label="Search contacts"
              className="pl-8"
            />
          </div>
          <FilterBar
            filters={quickFilters}
            moreFilters={moreFilters}
            values={toFilterValues(state)}
            onChange={(values) => void set(fromFilterValues(values))}
          />
        </div>
        <DataTable<ContactListItem>
          label="Contacts"
          data={rows}
          columns={COLUMNS}
          getRowId={(r) => r.id}
          getRowHref={(r) => `/contacts/${r.id}`}
          onRowClick={(r) =>
            void navigate({ to: "/contacts/$contactId", params: { contactId: r.id } })
          }
          sort={parseSort(state.sort)}
          onSortChange={(s) => void set({ sort: `${s.field}:${s.dir}` })}
          visibleColumns={state.columns ?? DEFAULT_COLUMNS}
          onColumnsChange={(columns) => void set({ columns })}
          selectedIds={selected}
          onSelectionChange={setSelected}
          bulkActions={
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={bulk.isPending}>
                    <UserPlus /> Assign owner
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                  {users
                    .filter((u) => u.active)
                    .map((u) => (
                      <DropdownMenuItem
                        key={u.id}
                        onSelect={() => void runBulk("assignOwner", u.id)}
                      >
                        {u.name}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {isAdmin && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bulk.isPending}
                  onClick={() => void runBulk("enrollAi")}
                >
                  <Sparkles /> Enroll in AI
                </Button>
              )}
            </>
          }
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyState={emptyState}
        />
      </div>

      <ImportLeadsDialog open={importOpen} onOpenChange={setImportOpen} />
      <ViewNameDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="Save view"
        showShare
        saving={createView.isPending}
        onSave={(value) =>
          void createView
            .mutateAsync({ object: "contacts", ...value, ...toSavedViewBody(state) })
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
                ? "It is shared, so it disappears for everyone in this workspace. Contacts are not affected."
                : "Contacts are not affected."
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
