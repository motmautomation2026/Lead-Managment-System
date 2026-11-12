import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, ExternalLink, ListChecks, Phone, PhoneCall, Search } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/crm/page-header";
import { FilterBar } from "@/components/crm/filter-bar";
import type { FilterDef } from "@/components/crm/filter-model";
import { DataTable } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RelativeTime } from "@/components/crm/relative-time";
import { InlineOwner, RowMenu } from "@/features/crm/row-controls";
import { afterMenuClose } from "@/lib/after-menu-close";
import { useCreateTaskDialog } from "@/app/add-lead-context";
import { Link, useNavigate } from "@tanstack/react-router";
import { CompanyPicker } from "@/features/companies/company-picker";
import { SavedViewTabs } from "@/features/crm/saved-view-tabs";
import { toSavedViewBody } from "@/features/crm/saved-views";
import { useListViews } from "@/features/crm/use-list-views";
import { LogCallFlow } from "@/features/work/log-call-flow";
import { ContactFilter, DealFilterChip } from "@/features/work/work-filters";
import { ScheduleMeetingFlow } from "@/features/work/schedule-meeting-flow";
import { backend } from "@/lib/backend-client";
import { label } from "@/lib/labels";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useListUrlState } from "@/lib/use-list-url-state";
import { useListPrefs } from "@/lib/list-prefs";
import { dateInputValue, istParts, toIsoFromIst } from "@/lib/dates";
import { toastUndo } from "@/lib/toast-undo";
import {
  refreshWork,
  useCompany,
  useCompleteTask,
  useSession,
  useTaskCount,
  useTaskList,
  useUpdateTask,
  messageFromError,
} from "@/store";
import { useWorkspace } from "@/store/workspace-context";
import { TASK_TYPES, type TaskListItem } from "@/types";
import { taskColumns } from "./task-columns";
import { TaskSheet } from "./task-sheet";
import {
  DEFAULT_COLUMNS,
  MY_DUE_TODAY,
  MY_OVERDUE,
  TASK_VIEW_SPEC,
  fromFilterValues,
  parseSort,
  tasksSearchSchema,
  toApiParams,
  toFilterValues,
} from "./tasks-search";

const EMPTY_TEXT: Record<string, string> = {
  overdue: "Nothing overdue.",
  today: "No tasks due today.",
  upcoming: "Nothing scheduled after today.",
  completed: "No completed tasks yet.",
};

/** One per-id write for each selected task; returns how many failed (with the first error). */
async function eachTask(ids: string[], write: (id: string) => Promise<unknown>) {
  let failed = 0;
  let first: unknown = null;
  for (const id of ids) {
    try {
      await write(id);
    } catch (error) {
      failed += 1;
      first ??= error;
    }
  }
  return { failed, first };
}

type TaskPatch = { ownerId?: string; dueAt?: string };

const RESCHEDULE = [
  { days: 1, label: "Tomorrow" },
  { days: 3, label: "In 3 days" },
  { days: 7, label: "Next week" },
] as const;

/** `days` from today (IST), keeping the task's IST time of day. */
const shiftedDue = (dueAt: string, days: number) =>
  toIsoFromIst(dateInputValue(days), `${istParts(dueAt).time}:00`);
const tasksText = (n: number) => `${n} task${n === 1 ? "" : "s"}`;

export function TasksPage() {
  const [state, set] = useListUrlState(tasksSearchSchema);
  const prefs = useListPrefs("tasks", state.columns, DEFAULT_COLUMNS);
  const { users } = useSession();
  const createTask = useCreateTaskDialog();
  const client = useQueryClient();
  const { currentWorkspaceId: ws } = useWorkspace();
  const complete = useCompleteTask();

  const params = useMemo(() => toApiParams(state), [state]);
  // A bare /tasks is rewritten to the My open view first (useListViews); don't fetch "all" meanwhile.
  const landing = Object.keys(state).length === 0;
  const list = useTaskList({ ...params, limit: prefs.limit }, !landing);
  const count = useTaskCount(params, !landing);
  const overdue = useTaskCount(MY_OVERDUE);
  const dueToday = useTaskCount(MY_DUE_TODAY);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  const filterCompany = useCompany(state.companyId);

  const [qInput, setQInput] = useState(state.q ?? "");
  const debouncedQ = useDebouncedValue(qInput, 300);
  const lastQ = useRef(debouncedQ);
  useEffect(() => {
    if (lastQ.current === debouncedQ) return;
    lastQ.current = debouncedQ;
    void set({ q: debouncedQ || undefined }, { replace: true });
  }, [debouncedQ, set]);

  const viewsCtl = useListViews(TASK_VIEW_SPEC, state, set, (next) => {
    setQInput(next.q ?? "");
    lastQ.current = next.q ?? "";
  });

  const [selected, setSelected] = useState<string[]>([]);
  const selectionKey = JSON.stringify(params);
  const [selectionFor, setSelectionFor] = useState(selectionKey);
  if (selectionFor !== selectionKey) {
    setSelectionFor(selectionKey);
    setSelected([]);
  }
  const [sheetTask, setSheetTask] = useState<TaskListItem | null>(null);
  // The last call target stays set after its dialog closes: LogCallFlow's prompts need it.
  const [call, setCall] = useState<{ leadId: string; taskId: string; open: boolean } | null>(null);
  const [meetingFor, setMeetingFor] = useState<{ leadId: string; taskId: string } | null>(null);
  const [bulkOwner, setBulkOwner] = useState("");
  const [confirm, setConfirm] = useState<"complete" | "reassign" | "reschedule" | null>(null);
  const [bulkDays, setBulkDays] = useState<number>(1);
  const [bulkBusy, setBulkBusy] = useState(false);
  const update = useUpdateTask();
  const navigate = useNavigate();
  const userName = (id: string) => users.find((u) => u.id === id)?.name ?? "the new owner";

  /** One row edit (inline owner / due, row menu) with Undo back to the old values. */
  const editTask = async (
    task: TaskListItem,
    patch: TaskPatch,
    message: string,
    undo: TaskPatch | null,
  ) => {
    try {
      await update.mutateAsync({ id: task.id, input: patch });
      if (!undo) return void toast.success(message);
      toastUndo(
        message,
        () =>
          void update.mutateAsync({ id: task.id, input: undo }).then(
            () => toast.success("Change undone"),
            (error: unknown) => toast.error(messageFromError(error)),
          ),
      );
    } catch (error) {
      toast.error(messageFromError(error));
    }
  };
  const assignTask = (t: TaskListItem, ownerId: string) =>
    void editTask(
      t,
      { ownerId },
      `“${t.title}” assigned to ${userName(ownerId)}`,
      t.ownerId ? { ownerId: t.ownerId } : null,
    );
  const moveDue = (t: TaskListItem, dueAt: string, when: string) =>
    void editTask(t, { dueAt }, `“${t.title}” moved to ${when}`, { dueAt: t.dueAt });

  /** Done toggle: a call logs the call (which completes the task); a meeting task schedules it. */
  const done = (task: TaskListItem) => {
    if (task.status !== "open") return;
    if (task.type === "call")
      return setCall({ leadId: task.contact.id, taskId: task.id, open: true });
    if (task.type === "schedule_meeting")
      return setMeetingFor({ leadId: task.contact.id, taskId: task.id });
    complete.mutate(task.id, {
      onSuccess: () => toast.success("Task completed"),
      onError: (error) => toast.error(error.message),
    });
  };
  const columns = taskColumns(done).map((c) =>
    c.id === "owner"
      ? {
          ...c,
          cell: (t: TaskListItem) =>
            t.status === "open" ? (
              <InlineOwner
                value={t.ownerId ? { id: t.ownerId, name: t.ownerName ?? "Owner" } : null}
                users={users}
                label={`Owner of ${t.title}`}
                onChange={(ownerId) => assignTask(t, ownerId)}
              />
            ) : (
              c.cell(t)
            ),
        }
      : c.id === "dueAt"
        ? {
            ...c,
            cell: (t: TaskListItem) =>
              t.status === "open" ? (
                <span className="relative inline-flex">
                  <RelativeTime value={t.dueAt} className={t.isOverdue ? "text-destructive" : ""} />
                  {/* The native date picker over the text: keyboard and touch friendly. */}
                  <input
                    type="date"
                    aria-label={`Due date of ${t.title}`}
                    value={istParts(t.dueAt).date}
                    onChange={(e) =>
                      e.target.value &&
                      moveDue(
                        t,
                        toIsoFromIst(e.target.value, `${istParts(t.dueAt).time}:00`),
                        e.target.value,
                      )
                    }
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </span>
              ) : (
                c.cell(t)
              ),
          }
        : c,
  );
  const rowActions = (t: TaskListItem) => (
    <RowMenu label={`Actions for ${t.title}`}>
      {t.status === "open" && (t.type === "call" || t.type === "follow_up") && (
        <DropdownMenuItem
          onSelect={afterMenuClose(() =>
            setCall({ leadId: t.contact.id, taskId: t.id, open: true }),
          )}
        >
          <Phone /> Log call
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onSelect={() =>
          void navigate({ to: "/contacts/$contactId", params: { contactId: t.contact.id } })
        }
      >
        <ExternalLink /> Open contact
      </DropdownMenuItem>
      {t.status === "open" && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Reschedule</DropdownMenuLabel>
          {RESCHEDULE.map((r) => (
            <DropdownMenuItem
              key={r.days}
              onSelect={() => moveDue(t, shiftedDue(t.dueAt, r.days), r.label.toLowerCase())}
            >
              {r.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Assign to</DropdownMenuLabel>
          {users
            .filter((u) => u.active && u.id !== t.ownerId)
            .map((u) => (
              <DropdownMenuItem key={u.id} onSelect={() => assignTask(t, u.id)}>
                {u.name}
              </DropdownMenuItem>
            ))}
        </>
      )}
    </RowMenu>
  );

  /** Puts the old owner / due date back on each task (Undo of a bulk change). */
  const restore = async (before: Map<string, TaskPatch>) => {
    const { failed } = await eachTask([...before.keys()], (id) =>
      backend.tasks.update(id, before.get(id)!),
    );
    await refreshWork(client, ws);
    if (failed) toast.error(`Couldn't undo ${tasksText(failed)}`);
    else toast.success("Change undone");
  };

  const bulk = async (kind: "complete" | "reassign" | "reschedule") => {
    setBulkBusy(true);
    const ids = selected;
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    // Undo only where it is reversible: an old owner to go back to, or the old due date.
    const before = new Map<string, TaskPatch>();
    for (const id of ids) {
      const t = byId.get(id);
      if (!t) continue;
      if (kind === "reassign" && t.ownerId && t.ownerId !== bulkOwner)
        before.set(id, { ownerId: t.ownerId });
      if (kind === "reschedule") before.set(id, { dueAt: t.dueAt });
    }
    const { failed, first } = await eachTask(ids, (id) =>
      kind === "complete"
        ? backend.tasks.complete(id)
        : kind === "reassign"
          ? backend.tasks.update(id, { ownerId: bulkOwner })
          : backend.tasks.update(id, { dueAt: shiftedDue(byId.get(id)!.dueAt, bulkDays) }),
    );
    setBulkBusy(false);
    setConfirm(null);
    await refreshWork(client, ws);
    const ok = ids.length - failed;
    const verb =
      kind === "complete" ? "completed" : kind === "reassign" ? "reassigned" : "rescheduled";
    if (failed === 0) {
      if (before.size > 0) toastUndo(`${tasksText(ok)} ${verb}`, () => void restore(before));
      else toast.success(`${tasksText(ok)} ${verb}`);
    } else
      toast.error(
        `${ok} ${verb}, ${failed} failed: ${first instanceof Error ? first.message : "request failed"}`,
      );
    setSelected([]);
  };

  const ownerOptions = [
    { value: "me", label: "Me" },
    { value: "none", label: "No owner" },
    ...users.map((u) => ({ value: u.id, label: u.name })),
  ];
  const quickFilters: FilterDef[] = [
    { id: "ownerId", label: "Owner", type: "multi", options: ownerOptions },
    {
      id: "type",
      label: "Type",
      type: "multi",
      options: TASK_TYPES.map((t) => ({ value: t, label: label(t) })),
    },
    {
      id: "origin",
      label: "Origin",
      type: "multi",
      options: [
        { value: "manual", label: "Manual" },
        { value: "automation", label: "Automation" },
        { value: "agent", label: "AI Agent" },
      ],
    },
    { id: "dueRange", label: "Due date", type: "dateRange" },
  ];
  const moreFilters: FilterDef[] = [
    {
      id: "status",
      label: "Status",
      type: "multi",
      options: [
        { value: "open", label: "Open" },
        { value: "completed", label: "Completed" },
        { value: "cancelled", label: "Cancelled" },
        { value: "all", label: "All" },
      ],
    },
  ];

  const hasFilters = Object.keys(toSavedViewBody(state, toApiParams).filters).length > 0;
  const emptyState = (
    <EmptyState
      icon={ListChecks}
      title={hasFilters ? "No tasks here" : "No open tasks"}
      text={
        EMPTY_TEXT[viewsCtl.activeId] ??
        (hasFilters
          ? "Try other filters or a different search."
          : "Create a task to plan a follow-up.")
      }
      action={<Button onClick={() => createTask.open()}>Create task</Button>}
    />
  );

  return (
    <div className="pb-24">
      <PageHeader
        title="Tasks"
        count={count.data?.count ?? null}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/tasks/calls">
                <PhoneCall /> Start calling
              </Link>
            </Button>
          </>
        }
        primaryAction={<Button onClick={() => createTask.open()}>Create task</Button>}
        tabs={
          <SavedViewTabs
            controller={viewsCtl}
            maxVisible={6}
            counts={{ overdue: overdue.data?.count, today: dueToday.data?.count }}
          />
        }
      />
      <div className="space-y-3 px-4 pt-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search title or contact"
              aria-label="Search tasks"
              data-list-search
              className="pl-8"
            />
          </div>
          <ContactFilter
            contactId={state.contactId}
            onChange={(contactId) => void set({ contactId })}
          />
          <DealFilterChip
            dealId={state.dealId}
            label="Tasks of this deal's contact"
            onClear={() => void set({ dealId: undefined })}
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
          <FilterBar
            filters={quickFilters}
            moreFilters={moreFilters}
            values={toFilterValues(state)}
            onChange={(values) => void set(fromFilterValues(values))}
          />
        </div>
        <DataTable<TaskListItem>
          label="Tasks"
          data={rows}
          columns={columns}
          getRowId={(r) => r.id}
          onRowClick={setSheetTask}
          rowActions={rowActions}
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
              <Button size="sm" variant="outline" onClick={() => setConfirm("complete")}>
                Complete
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    <CalendarClock /> Reschedule
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {RESCHEDULE.map((r) => (
                    <DropdownMenuItem
                      key={r.days}
                      onSelect={afterMenuClose(() => {
                        setBulkDays(r.days);
                        setConfirm("reschedule");
                      })}
                    >
                      {r.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Select
                value={bulkOwner}
                onValueChange={(v) => {
                  setBulkOwner(v);
                  setConfirm("reassign");
                }}
              >
                <SelectTrigger className="h-8 w-40" aria-label="Reassign to">
                  <SelectValue placeholder="Reassign to…" />
                </SelectTrigger>
                <SelectContent>
                  {users
                    .filter((u) => u.active)
                    .map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
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

      <TaskSheet
        task={sheetTask}
        onOpenChange={(open) => !open && setSheetTask(null)}
        onComplete={(t) => {
          setSheetTask(null);
          done(t);
        }}
        onLogCall={(t) => {
          setSheetTask(null);
          setCall({ leadId: t.contact.id, taskId: t.id, open: true });
        }}
      />
      {call && (
        <LogCallFlow
          key={call.taskId}
          leadId={call.leadId}
          taskId={call.taskId}
          open={call.open}
          onOpenChange={(open) => setCall({ ...call, open })}
        />
      )}
      {meetingFor && (
        <ScheduleMeetingFlow
          leadId={meetingFor.leadId}
          open
          onOpenChange={(open) => !open && setMeetingFor(null)}
        />
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirm(null);
            setBulkOwner("");
          }
        }}
        title={
          confirm === "complete"
            ? "Complete tasks"
            : confirm === "reschedule"
              ? "Reschedule tasks"
              : "Reassign tasks"
        }
        description={
          confirm === "complete"
            ? `Mark ${tasksText(selected.length)} as done?`
            : confirm === "reschedule"
              ? `Move ${tasksText(selected.length)} to ${
                  RESCHEDULE.find((r) => r.days === bulkDays)?.label.toLowerCase() ?? "later"
                }? Each keeps its time of day.`
              : `Reassign ${tasksText(selected.length)} to ${
                  users.find((u) => u.id === bulkOwner)?.name ?? "this owner"
                }?`
        }
        confirmLabel={
          confirm === "complete" ? "Complete" : confirm === "reschedule" ? "Reschedule" : "Reassign"
        }
        confirmVariant="default"
        disabled={bulkBusy}
        onConfirm={() => confirm && void bulk(confirm)}
      />
    </div>
  );
}
