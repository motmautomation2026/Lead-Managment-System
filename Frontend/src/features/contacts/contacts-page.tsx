import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  ExternalLink,
  ListPlus,
  Phone,
  Search,
  Sparkles,
  StickyNote,
  Upload,
  UserPlus,
  Users,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { PageHeader } from "@/components/crm/page-header";
import { FilterBar } from "@/components/crm/filter-bar";
import type { FilterDef } from "@/components/crm/filter-model";
import { DataTable } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { useAddLead, useCreateTaskDialog } from "@/app/add-lead-context";
import { ImportLeadsDialog } from "@/features/leads/import-leads-dialog";
import { AGENT_STATUS_LABEL } from "@/features/agent/agent-labels";
import { label } from "@/lib/labels";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useListUrlState } from "@/lib/use-list-url-state";
import { useListPrefs } from "@/lib/list-prefs";
import { toastUndo } from "@/lib/toast-undo";
import {
  messageFromError,
  useBulkContacts,
  useCompany,
  useContactAutomation,
  useContacts,
  useContactsCount,
  useIsAdmin,
  useLeadMutations,
  useSession,
} from "@/store";
import {
  LEAD_SOURCES,
  LIFECYCLE_STATES,
  PIPELINE_STAGES,
  type AgentStatus,
  type ContactListItem,
} from "@/types";
import {
  DEFAULT_COLUMNS,
  NO_FILTERS,
  contactsSearchSchema,
  fromFilterValues,
  parseSort,
  toApiParams,
  toFilterValues,
  CONTACT_VIEW_SPEC,
} from "./contacts-search";
import { CONTACT_COLUMNS as COLUMNS } from "./contact-columns";
import { CompanyPicker } from "@/features/companies/company-picker";
import { usePrefetchRecord } from "@/features/crm/prefetch";
import { SavedViewTabs } from "@/features/crm/saved-view-tabs";
import { toSavedViewBody } from "@/features/crm/saved-views";
import { useListViews } from "@/features/crm/use-list-views";
import { InlineOwner, RowMenu } from "@/features/crm/row-controls";
import { afterMenuClose } from "@/lib/after-menu-close";
import { LogCallFlow } from "@/features/work/log-call-flow";
import { NoteDialog } from "./note-dialog";

type BulkAction = { action: "assignOwner" | "enrollAi"; ownerId?: string | undefined };
/** Selections above this ask first (UX-2 rule 4). */
const BULK_CONFIRM_OVER = 20;

const options = (values: readonly string[]) =>
  values.map((value) => ({ value, label: label(value) }));

const EMPTY_TEXT: Record<string, string> = {
  mine: "No contacts are assigned to you.",
  recent: "No contacts were added in the last 7 days.",
  unassigned: "Every contact has an owner.",
};

const RecordPeek = lazy(() => import("@/features/crm/record-peek"));

export function ContactsPage() {
  const [state, set] = useListUrlState(contactsSearchSchema);
  const prefs = useListPrefs("contacts", state.columns, DEFAULT_COLUMNS);
  const navigate = useNavigate();
  const prefetch = usePrefetchRecord();
  const isAdmin = useIsAdmin();
  const { users } = useSession();
  const createContact = useAddLead();
  const createTask = useCreateTaskDialog();
  const [importOpen, setImportOpen] = useState(false);

  const params = useMemo(() => toApiParams(state), [state]);
  const list = useContacts({ ...params, limit: prefs.limit });
  const count = useContactsCount(params);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  const bulk = useBulkContacts();
  const automation = useContactAutomation();
  // REL-1: automation on/off for the selection or the whole filtered list (always confirmed with the count).
  const [pendingAutomation, setPendingAutomation] = useState<{
    enabled: boolean;
    all: boolean;
  } | null>(null);
  const filterCompany = useCompany(state.companyId);

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

  const viewsCtl = useListViews(CONTACT_VIEW_SPEC, state, set, (next) => {
    setQInput(next.q ?? "");
    lastQ.current = next.q ?? "";
  });
  const activeId = viewsCtl.activeId;
  const applyView = viewsCtl.apply;

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
    { id: "lastActivity", label: "Last activity", type: "dateRange" },
  ];

  const nameOf = (id: string) => rows.find((r) => r.id === id)?.name ?? id;
  const userName = (id: string) => users.find((u) => u.id === id)?.name ?? "the new owner";
  const plural = (n: number) => `${n} contact${n === 1 ? "" : "s"}`;
  const [pendingBulk, setPendingBulk] = useState<BulkAction | null>(null);
  const [rowDialog, setRowDialog] = useState<{
    kind: "call" | "note";
    id: string;
    open: boolean;
  } | null>(null);
  const { addNote } = useLeadMutations();

  /** Puts owners back (grouped by the previous owner); contacts that had none can't be unassigned. */
  const undoAssign = async (before: Map<string, string>) => {
    const groups = new Map<string, string[]>();
    for (const [id, owner] of before) groups.set(owner, [...(groups.get(owner) ?? []), id]);
    try {
      for (const [ownerId, ids] of groups)
        await bulk.mutateAsync({ ids, action: "assignOwner", ownerId });
      toast.success("Owner change undone");
    } catch (error) {
      toast.error(messageFromError(error));
    }
  };

  const runBulk = async (ids: string[], { action, ownerId }: BulkAction) => {
    const verb =
      action === "assignOwner" ? `assigned to ${userName(ownerId ?? "")}` : "enrolled in AI";
    const previous = new Map(
      ids.map((id) => [id, rows.find((r) => r.id === id)?.owner?.id ?? null] as const),
    );
    try {
      const results = await bulk.mutateAsync({ ids, action, ...(ownerId ? { ownerId } : {}) });
      const failed = results.filter((r) => !r.ok);
      const done = results.length - failed.length;
      const subject = ids !== selected && done === 1 ? nameOf(ids[0]!) : plural(done);
      // Undo only where it is reversible: an owner change from another owner.
      const undoable = new Map<string, string>();
      if (action === "assignOwner")
        for (const r of results) {
          const prev = previous.get(r.id);
          if (r.ok && prev && prev !== ownerId) undoable.set(r.id, prev);
        }
      if (failed.length === 0) {
        if (undoable.size > 0) toastUndo(`${subject} ${verb}`, () => void undoAssign(undoable));
        else toast.success(`${subject} ${verb}`);
      } else {
        toast.warning(`${done} of ${results.length} ${verb}; ${failed.length} not`, {
          description: failed
            .slice(0, 5)
            .map((f) => `${nameOf(f.id)}: ${f.error ?? "failed"}`)
            .join(" · "),
        });
      }
      if (ids === selected) setSelected([]);
    } catch (error) {
      toast.error(messageFromError(error));
    }
  };
  const runAutomation = async ({ enabled, all }: { enabled: boolean; all: boolean }) => {
    try {
      const { sort: _sort, ...filters } = params;
      const result = all
        ? await automation.mutateAsync({
            filtered: filters,
            expectedCount: count.data?.count ?? 0,
            enabled,
          })
        : await automation.mutateAsync({ ids: selected, enabled });
      const verb = enabled ? "switched on" : "switched off";
      toast.success(`Automation ${verb} for ${plural(result.changed)}`, {
        description: result.unchanged
          ? `${plural(result.unchanged)} unchanged (already ${enabled ? "on" : "off"}, or not yours to change).`
          : undefined,
      });
      setSelected([]);
    } catch (error) {
      toast.error(messageFromError(error));
    }
  };
  const automationCount = pendingAutomation?.all ? (count.data?.count ?? 0) : selected.length;

  /** Large batches ask first (count + what happens); small ones run at once with Undo. */
  const askBulk = (action: BulkAction) =>
    selected.length > BULK_CONFIRM_OVER
      ? afterMenuClose(() => setPendingBulk(action))()
      : void runBulk(selected, action);

  const columns = COLUMNS.map((c) =>
    c.id === "owner"
      ? {
          ...c,
          cell: (r: ContactListItem) => (
            <InlineOwner
              value={r.owner}
              users={users}
              label={`Owner of ${r.name || "contact"}`}
              onChange={(ownerId) => void runBulk([r.id], { action: "assignOwner", ownerId })}
            />
          ),
        }
      : c,
  );
  const rowActions = (r: ContactListItem) => (
    <RowMenu label={`Actions for ${r.name || "contact"}`}>
      {r.lifecycle !== "do_not_contact" && (
        <DropdownMenuItem
          onSelect={afterMenuClose(() => setRowDialog({ kind: "call", id: r.id, open: true }))}
        >
          <Phone /> Log call
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onSelect={afterMenuClose(() => setRowDialog({ kind: "note", id: r.id, open: true }))}
      >
        <StickyNote /> Add note
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={afterMenuClose(() =>
          createTask.open({ contact: { id: r.id, name: r.name || "Contact" } }),
        )}
      >
        <ListPlus /> Add task
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => void navigate({ to: "/contacts/$contactId", params: { contactId: r.id } })}
      >
        <ExternalLink /> Open
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Assign to</DropdownMenuLabel>
      {users
        .filter((u) => u.active && u.id !== r.owner?.id)
        .map((u) => (
          <DropdownMenuItem
            key={u.id}
            onSelect={() => void runBulk([r.id], { action: "assignOwner", ownerId: u.id })}
          >
            {u.name}
          </DropdownMenuItem>
        ))}
    </RowMenu>
  );

  const hasFilters = Object.keys(toSavedViewBody(state, toApiParams).filters).length > 0;
  const emptyState = !hasFilters ? (
    <EmptyState
      icon={Users}
      title="No contacts yet"
      text="Create a contact or import a CSV."
      action={
        <div className="flex gap-2">
          <Button onClick={() => createContact.open()}>Create contact</Button>
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
        menuActions={[{ label: "Import CSV", icon: Upload, onSelect: () => setImportOpen(true) }]}
        primaryAction={<Button onClick={() => createContact.open()}>Create contact</Button>}
        tabs={<SavedViewTabs controller={viewsCtl} />}
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
        </div>
        <DataTable<ContactListItem>
          label="Contacts"
          data={rows}
          columns={columns}
          rowActions={rowActions}
          getRowId={(r) => r.id}
          getRowHref={(r) => `/contacts/${r.id}`}
          onRowIntent={(r) => prefetch("contact", r.id)}
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
                        onSelect={() => askBulk({ action: "assignOwner", ownerId: u.id })}
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
                  onClick={() => askBulk({ action: "enrollAi" })}
                >
                  <Sparkles /> Enroll in AI
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={automation.isPending}>
                    <Workflow /> Automation
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>{plural(selected.length)} selected</DropdownMenuLabel>
                  <DropdownMenuItem
                    onSelect={afterMenuClose(() =>
                      setPendingAutomation({ enabled: true, all: false }),
                    )}
                  >
                    Turn on automation
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={afterMenuClose(() =>
                      setPendingAutomation({ enabled: false, all: false }),
                    )}
                  >
                    Turn off automation
                  </DropdownMenuItem>
                  {count.data && count.data.count > selected.length && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>
                        All {plural(count.data.count)} in this list
                      </DropdownMenuLabel>
                      <DropdownMenuItem
                        onSelect={afterMenuClose(() =>
                          setPendingAutomation({ enabled: true, all: true }),
                        )}
                      >
                        Turn on for all {count.data.count}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={afterMenuClose(() =>
                          setPendingAutomation({ enabled: false, all: true }),
                        )}
                      >
                        Turn off for all {count.data.count}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
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
      <ConfirmDialog
        open={pendingBulk !== null}
        onOpenChange={(open) => !open && setPendingBulk(null)}
        title={pendingBulk?.action === "enrollAi" ? "Enroll in AI" : "Assign owner"}
        description={
          pendingBulk?.action === "enrollAi"
            ? `Enroll ${plural(selected.length)} in the AI agent? Contacts it can't take are skipped and listed.`
            : `Make ${userName(pendingBulk?.ownerId ?? "")} the owner of ${plural(selected.length)}? Their open tasks follow the usual owner rules.`
        }
        confirmLabel={pendingBulk?.action === "enrollAi" ? "Enroll" : "Assign"}
        confirmVariant="default"
        disabled={bulk.isPending}
        onConfirm={() => {
          const action = pendingBulk;
          setPendingBulk(null);
          if (action) void runBulk(selected, action);
        }}
      />
      <ConfirmDialog
        open={pendingAutomation !== null}
        onOpenChange={(open) => !open && setPendingAutomation(null)}
        title={pendingAutomation?.enabled ? "Turn on automation" : "Turn off automation"}
        description={
          pendingAutomation?.enabled
            ? `Turn automation on for ${plural(automationCount)}? Automatic tasks, reminders, workflows and AI messages start from the next worker run; nothing from the past is replayed.${isAdmin ? "" : " Only your own contacts change."}`
            : `Turn automation off for ${plural(automationCount)}? No more automatic tasks, reminders or messages, and their workflow runs are paused. Sent messages stay sent.${isAdmin ? "" : " Only your own contacts change."}`
        }
        confirmLabel={
          pendingAutomation?.enabled
            ? `Turn on for ${automationCount}`
            : `Turn off for ${automationCount}`
        }
        confirmVariant={pendingAutomation?.enabled ? "default" : "destructive"}
        disabled={automation.isPending}
        onConfirm={() => {
          const next = pendingAutomation;
          setPendingAutomation(null);
          if (next) void runAutomation(next);
        }}
      />
      {rowDialog?.kind === "call" && (
        <LogCallFlow
          key={rowDialog.id}
          leadId={rowDialog.id}
          open={rowDialog.open}
          onOpenChange={(open) => setRowDialog({ ...rowDialog, open })}
        />
      )}
      <NoteDialog
        open={rowDialog?.kind === "note" && rowDialog.open}
        onOpenChange={(open) => !open && setRowDialog(null)}
        onSave={(body) =>
          addNote(rowDialog?.id ?? "", body).then(
            () => (toast.success("Note added"), true),
            (error: unknown) => (toast.error(messageFromError(error)), false),
          )
        }
      />
      {state.peek && (
        <Suspense fallback={null}>
          <RecordPeek
            type="contact"
            id={state.peek}
            onClose={() => void set({ peek: undefined })}
          />
        </Suspense>
      )}
    </div>
  );
}
