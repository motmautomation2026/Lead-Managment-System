import { useEffect, useMemo, useRef, useState } from "react";
import { ListChecks, Search } from "lucide-react";
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
import { useCreateTaskDialog } from "@/app/add-lead-context";
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
import {
  refreshWork,
  useCompany,
  useCompleteTask,
  useSession,
  useTaskCount,
  useTaskList,
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
  const [confirm, setConfirm] = useState<"complete" | "reassign" | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

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
  const columns = taskColumns(done);

  const bulk = async (kind: "complete" | "reassign") => {
    setBulkBusy(true);
    const { failed, first } = await eachTask(selected, (id) =>
      kind === "complete"
        ? backend.tasks.complete(id)
        : backend.tasks.update(id, { ownerId: bulkOwner }),
    );
    setBulkBusy(false);
    setConfirm(null);
    await refreshWork(client, ws);
    const ok = selected.length - failed;
    const verb = kind === "complete" ? "completed" : "reassigned";
    if (failed === 0) toast.success(`${ok} task${ok === 1 ? "" : "s"} ${verb}`);
    else
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
        title={confirm === "complete" ? "Complete tasks" : "Reassign tasks"}
        description={
          confirm === "complete"
            ? `Mark ${selected.length} task${selected.length === 1 ? "" : "s"} as done?`
            : `Reassign ${selected.length} task${selected.length === 1 ? "" : "s"} to ${
                users.find((u) => u.id === bulkOwner)?.name ?? "this owner"
              }?`
        }
        confirmLabel={confirm === "complete" ? "Complete" : "Reassign"}
        confirmVariant="default"
        disabled={bulkBusy}
        onConfirm={() => confirm && void bulk(confirm)}
      />
    </div>
  );
}
