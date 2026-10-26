import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type MouseEvent } from "react";
import { toast } from "sonner";
import { Bot, Copy, Plus, Search, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/crm/page-header";
import { DataTable, type DataTableColumn } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { RelativeTime } from "@/components/crm/relative-time";
import { AutomationTabs } from "@/features/automations/automation-tabs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StatusBadge } from "@/components/common/status-badge";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { messageFromError, useAutomations } from "@/store";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { workflowTriggerLabel } from "@/lib/labels";
import { BackendError } from "@/lib/backend-client";
import { WORKFLOW_TRIGGERS, type Workflow, type WorkflowTrigger } from "@/types";

/** Columns of the workflows table; the toggle, duplicate and delete cells call back into the page. */
function workflowColumns(actions: {
  disabled: boolean;
  onToggle: (w: Workflow, active: boolean) => void;
  onDuplicate: (w: Workflow) => void;
  onDelete: (w: Workflow) => void;
}): DataTableColumn<Workflow>[] {
  const stop = (e: MouseEvent) => e.stopPropagation();
  return [
    {
      id: "name",
      header: "Name",
      size: 260,
      hideable: false,
      cell: (w) => (
        <span className="min-w-0">
          <span className="block truncate font-medium">{w.name}</span>
          {w.description && (
            <span className="block truncate type-small text-muted-foreground">{w.description}</span>
          )}
        </span>
      ),
    },
    { id: "trigger", header: "Trigger", size: 220, cell: (w) => workflowTriggerLabel(w.trigger) },
    {
      id: "status",
      header: "Status",
      size: 150,
      cell: (w) => (
        <span className="inline-flex items-center gap-2" onClick={stop}>
          <Switch
            checked={w.status === "active"}
            disabled={actions.disabled}
            aria-label={`${w.name} active`}
            onCheckedChange={(v) => actions.onToggle(w, v)}
          />
          <StatusBadge value={w.status} />
        </span>
      ),
    },
    {
      id: "version",
      header: "Published",
      size: 180,
      cell: (w) => {
        const draft = w.versions.find((v) => v.status === "draft");
        return (
          <span className="inline-flex flex-wrap items-center gap-1">
            <StatusBadge value={`V${w.currentVersion} published`} tone="info" />
            {draft && <StatusBadge value={`V${draft.version} draft`} tone="warning" />}
          </span>
        );
      },
    },
    {
      id: "activeRuns",
      header: "Active runs",
      size: 140,
      cell: (w) => (
        <span className="num">
          {w.activeLeads}
          {w.failures > 0 && (
            <span className="ml-2 type-small text-destructive">{w.failures} failed</span>
          )}
        </span>
      ),
    },
    {
      id: "updatedAt",
      header: "Updated",
      size: 170,
      cell: (w) => <RelativeTime value={w.updatedAt} />,
    },
    {
      id: "actions",
      header: "Actions",
      size: 100,
      hideable: false,
      cell: (w) => (
        <span className="inline-flex gap-1" onClick={stop}>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            disabled={actions.disabled}
            onClick={() => actions.onDuplicate(w)}
            aria-label={`Duplicate ${w.name}`}
          >
            <Copy />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => actions.onDelete(w)}
            aria-label={`Delete ${w.name}`}
          >
            <Trash2 />
          </Button>
        </span>
      ),
    },
  ];
}

/** /automations: every workflow (a small reference list, searched here) with the same actions as before C6b. */
export function WorkflowsPage() {
  const {
    workflows,
    updateWorkflow,
    duplicateWorkflow,
    deleteWorkflow,
    addWorkflow,
    isLoading,
    error,
    isPending,
  } = useAutomations();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);
  const [forceDeleteTarget, setForceDeleteTarget] = useState<Workflow | null>(null);
  const [q, setQ] = useState("");
  const mutate = async (work: () => Promise<unknown>, success: string) => {
    try {
      await work();
      toast.success(success);
    } catch (failure) {
      toast.error(messageFromError(failure));
    }
  };

  const filteredWorkflows = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return workflows;
    return workflows.filter((w) =>
      `${w.name} ${w.description ?? ""} ${workflowTriggerLabel(w.trigger)}`
        .toLowerCase()
        .includes(query),
    );
  }, [workflows, q]);

  const columns = workflowColumns({
    disabled: isPending,
    onToggle: (w, v) =>
      void mutate(
        () => updateWorkflow(w.id, { status: v ? "active" : "paused" }),
        v ? "Workflow activated" : "Workflow paused",
      ),
    onDuplicate: (w) => void mutate(() => duplicateWorkflow(w.id), "Workflow duplicated"),
    onDelete: setDeleteTarget,
  });
  const newButton = (
    <Button onClick={() => setCreateOpen(true)}>
      <Plus /> New workflow
    </Button>
  );

  return (
    <div className="pb-24">
      <PageHeader
        title="Workflows"
        count={isLoading ? null : workflows.length}
        description="Workflows are defined here and executed by the backend automation worker. Publishing a version changes live behaviour."
        primaryAction={newButton}
        tabs={<AutomationTabs />}
      />
      <div className="space-y-3 px-4 pt-4 sm:px-6">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search workflows"
            aria-label="Search workflows"
            data-list-search
            className="pl-8"
          />
        </div>
        <DataTable<Workflow>
          label="Workflows"
          data={filteredWorkflows}
          columns={columns}
          getRowId={(w) => w.id}
          getRowHref={(w) => `/automations/workflows/${w.id}`}
          onRowClick={(w) =>
            void navigate({
              to: "/automations/workflows/$workflowId",
              params: { workflowId: w.id },
            })
          }
          isLoading={isLoading}
          error={error}
          emptyState={
            <EmptyState
              icon={Bot}
              title={q.trim() ? `No workflows match "${q.trim()}"` : "No workflows yet"}
              text="Managers own the automation: add or reorder steps, change delays and swap templates here - no developer needs to touch code."
              action={newButton}
            />
          }
        />
      </div>
      <NewWorkflowDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSave={(input) => void mutate(() => addWorkflow(input), "Workflow draft created")}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(value) => {
          if (!value) setDeleteTarget(null);
        }}
        title={`Delete "${deleteTarget?.name ?? ""}"?`}
        description="This removes the workflow and all of its versions and steps. Workflows that leads have ever been enrolled in need a second confirmation - pausing is the non-destructive alternative."
        disabled={isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          const target = deleteTarget;
          setDeleteTarget(null);
          deleteWorkflow(target.id)
            .then(() => toast.success("Workflow deleted"))
            .catch((failure: unknown) => {
              if (
                failure instanceof BackendError &&
                (failure.details as { reason?: string } | undefined)?.reason ===
                  "has_enrollment_history"
              ) {
                setForceDeleteTarget(target);
                return;
              }
              toast.error(messageFromError(failure));
            });
        }}
      />
      <ConfirmDialog
        open={!!forceDeleteTarget}
        onOpenChange={(value) => {
          if (!value) setForceDeleteTarget(null);
        }}
        title={`Force delete "${forceDeleteTarget?.name ?? ""}"?`}
        description="Leads have been enrolled in this workflow. Force-deleting permanently erases that enrollment history (which runs, when, what happened) - this cannot be undone. Pausing the workflow is the reversible alternative."
        confirmLabel="Force delete"
        disabled={isPending}
        onConfirm={() => {
          if (!forceDeleteTarget) return;
          const target = forceDeleteTarget;
          setForceDeleteTarget(null);
          void mutate(
            () => deleteWorkflow(target.id, true),
            "Workflow and its enrollment history deleted",
          );
        }}
      />
    </div>
  );
}

function NewWorkflowDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onSave: (input: {
    name: string;
    description?: string | undefined;
    trigger: WorkflowTrigger;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState<WorkflowTrigger>("manual_enrollment");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="mb-1.5 block text-xs">Name</Label>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">Description</Label>
            <Input value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">Trigger</Label>
            <Select value={trigger} onValueChange={(value) => setTrigger(value as WorkflowTrigger)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORKFLOW_TRIGGERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {workflowTriggerLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim()}
            onClick={() => {
              onSave({ name: name.trim(), description: description.trim() || undefined, trigger });
              onOpenChange(false);
              setName("");
              setDescription("");
            }}
          >
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
