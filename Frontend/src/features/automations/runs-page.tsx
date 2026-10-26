import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Workflow as WorkflowIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/crm/page-header";
import { ViewTabs } from "@/components/crm/view-tabs";
import { FilterBar } from "@/components/crm/filter-bar";
import type { FilterDef } from "@/components/crm/filter-model";
import { DataTable, type DataTableColumn } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { RelativeTime } from "@/components/crm/relative-time";
import { StatusBadge } from "@/components/common/status-badge";
import { usePrefetchRecord } from "@/features/crm/prefetch";
import { RefLink } from "@/features/work/ref-link";
import { ContactFilter } from "@/features/work/work-filters";
import { label } from "@/lib/labels";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useListUrlState } from "@/lib/use-list-url-state";
import {
  useRunCount,
  useRunList,
  useScheduledActionCount,
  useScheduledActionList,
  useWorkflowList,
} from "@/store";
import {
  RUN_STATUSES,
  SCHEDULED_ACTION_STATUSES,
  type RunListItem,
  type ScheduledActionListItem,
} from "@/types";
import { AutomationTabs } from "./automation-tabs";
import { currentStepText } from "./run-labels";
import { RunSheet } from "./run-sheet";
import {
  fromFilterValues,
  parseSort,
  runsSearchSchema,
  toFilterValues,
  toRunParams,
  toStepParams,
} from "./runs-search";

const RUN_COLUMNS: DataTableColumn<RunListItem>[] = [
  {
    id: "contact",
    header: "Contact",
    hideable: false,
    cell: (r) => <RefLink type="contact" value={r.contact} />,
  },
  { id: "workflow", header: "Workflow", cell: (r) => `${r.workflow.name} · V${r.version}` },
  {
    id: "step",
    header: "Current step",
    size: 220,
    cell: (r) => (
      <span className="min-w-0">
        <span className="block truncate">{currentStepText(r)}</span>
        {r.lastError && (
          <span className="block truncate type-small text-destructive">{r.lastError}</span>
        )}
      </span>
    ),
  },
  { id: "status", header: "Status", size: 130, cell: (r) => <StatusBadge value={r.status} /> },
  {
    id: "startedAt",
    header: "Started",
    sortable: true,
    size: 170,
    cell: (r) => <RelativeTime value={r.startedAt} />,
  },
  {
    id: "next",
    header: "Next action",
    size: 170,
    cell: (r) => (r.nextRunAt ? <RelativeTime value={r.nextRunAt} /> : "–"),
  },
];

const STEP_COLUMNS: DataTableColumn<ScheduledActionListItem>[] = [
  {
    id: "contact",
    header: "Contact",
    hideable: false,
    cell: (a) => <RefLink type="contact" value={a.contact} />,
  },
  { id: "workflow", header: "Workflow", cell: (a) => a.workflow.name },
  {
    id: "step",
    header: "Step",
    cell: (a) => `${a.stepOrder != null ? `${a.stepOrder + 1} · ` : ""}${label(a.actionType)}`,
  },
  {
    id: "scheduledFor",
    header: "Scheduled for",
    sortable: true,
    size: 170,
    cell: (a) => <RelativeTime value={a.scheduledFor} />,
  },
  { id: "status", header: "Status", size: 130, cell: (a) => <StatusBadge value={a.status} /> },
  {
    id: "attempts",
    header: "Attempts / error",
    size: 220,
    cell: (a) => (
      <span className="truncate type-small text-muted-foreground">
        {a.attemptCount}/{a.maxAttempts}
        {a.lastError ? ` · ${a.lastError}` : ""}
      </span>
    ),
  },
];

/** /automations/runs: Runs and Scheduled steps on the list standard (C6b). */
export function RunsPage() {
  const [state, set] = useListUrlState(runsSearchSchema);
  const tab = state.tab ?? "runs";
  const prefetch = usePrefetchRecord();
  const workflows = useWorkflowList();

  const runParams = useMemo(() => toRunParams(state), [state]);
  const stepParams = useMemo(() => toStepParams(state), [state]);
  const runs = useRunList(runParams, tab === "runs");
  const steps = useScheduledActionList(stepParams, tab === "steps");
  const runCount = useRunCount(runParams);
  const stepCount = useScheduledActionCount(stepParams);
  const runRows = useMemo(() => runs.data?.pages.flatMap((p) => p.data) ?? [], [runs.data]);
  const stepRows = useMemo(() => steps.data?.pages.flatMap((p) => p.data) ?? [], [steps.data]);

  // The Sheet follows the row, so a Pause/Resume shows the refetched status.
  const [sheetRun, setSheetRun] = useState<RunListItem | null>(null);
  const sheetRow = sheetRun ? (runRows.find((r) => r.id === sheetRun.id) ?? sheetRun) : null;

  const [qInput, setQInput] = useState(state.q ?? "");
  const debouncedQ = useDebouncedValue(qInput, 300);
  const lastQ = useRef(debouncedQ);
  useEffect(() => {
    if (lastQ.current === debouncedQ) return;
    lastQ.current = debouncedQ;
    void set({ q: debouncedQ || undefined }, { replace: true });
  }, [debouncedQ, set]);

  const statuses = tab === "steps" ? SCHEDULED_ACTION_STATUSES : RUN_STATUSES;
  const filters: FilterDef[] = [
    {
      id: "status",
      label: "Status",
      type: "multi",
      options: statuses.map((s) => ({ value: s, label: label(s) })),
    },
    {
      id: "workflowId",
      label: "Workflow",
      type: "multi",
      options: (workflows.data?.data ?? []).map((w) => ({ value: w.id, label: w.name })),
    },
    { id: "dateRange", label: tab === "steps" ? "Due" : "Started", type: "dateRange" },
  ];
  const sort = parseSort(state);
  const onSortChange = (s: { field: string; dir: "asc" | "desc" }) =>
    void set({ sort: `${s.field}:${s.dir}` });
  const empty = (
    <EmptyState
      icon={WorkflowIcon}
      title={tab === "steps" ? "No scheduled steps" : "No workflow runs"}
      text="Try other filters, or enroll a contact in a workflow from their record."
    />
  );

  return (
    <div className="pb-24">
      <PageHeader
        title="Runs"
        count={(tab === "steps" ? stepCount : runCount).data?.count ?? null}
        description="Workflow runs and their scheduled steps, as the backend worker executes them."
        tabs={<AutomationTabs />}
      />
      <div className="space-y-3 px-4 pt-4 sm:px-6">
        <ViewTabs
          views={[
            { id: "runs", label: "Runs", count: runCount.data?.count },
            { id: "steps", label: "Scheduled steps", count: stepCount.data?.count },
          ]}
          activeId={tab}
          onChange={(id) =>
            void set({ tab: id === "steps" ? "steps" : undefined, sort: undefined })
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search by contact name"
              aria-label="Search runs"
              data-list-search
              className="pl-8"
            />
          </div>
          <ContactFilter
            contactId={state.contactId}
            onChange={(contactId) => void set({ contactId })}
          />
          <FilterBar
            filters={filters}
            values={toFilterValues(state)}
            onChange={(values) => void set(fromFilterValues(state, values))}
          />
        </div>
        {tab === "runs" ? (
          <DataTable<RunListItem>
            label="Workflow runs"
            data={runRows}
            columns={RUN_COLUMNS}
            getRowId={(r) => r.id}
            onRowClick={setSheetRun}
            onRowIntent={(r) => prefetch("contact", r.contact.id)}
            sort={sort}
            onSortChange={onSortChange}
            hasNextPage={runs.hasNextPage}
            isFetchingNextPage={runs.isFetchingNextPage}
            onLoadMore={() => void runs.fetchNextPage()}
            isLoading={runs.isLoading}
            error={runs.error}
            onRetry={() => void runs.refetch()}
            emptyState={empty}
          />
        ) : (
          <DataTable<ScheduledActionListItem>
            label="Scheduled steps"
            data={stepRows}
            columns={STEP_COLUMNS}
            getRowId={(a) => a.id}
            onRowIntent={(a) => prefetch("contact", a.contact.id)}
            sort={sort}
            onSortChange={onSortChange}
            hasNextPage={steps.hasNextPage}
            isFetchingNextPage={steps.isFetchingNextPage}
            onLoadMore={() => void steps.fetchNextPage()}
            isLoading={steps.isLoading}
            error={steps.error}
            onRetry={() => void steps.refetch()}
            emptyState={empty}
          />
        )}
      </div>
      <RunSheet run={sheetRow} onOpenChange={(open) => !open && setSheetRun(null)} />
    </div>
  );
}
