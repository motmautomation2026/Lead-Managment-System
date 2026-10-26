import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PropertyList } from "@/components/crm/property-list";
import { RelativeTime } from "@/components/crm/relative-time";
import { StatusBadge } from "@/components/common/status-badge";
import { ErrorBlock } from "@/components/common/server-state";
import { Skeleton } from "@/components/ui/skeleton";
import { RefLink } from "@/features/work/ref-link";
import { label } from "@/lib/labels";
import { messageFromError, useRunAction, useScheduledActionList, type RunAction } from "@/store";
import type { RunListItem } from "@/types";
import { currentStepText, runActions } from "./run-labels";

const DONE: Record<RunAction, string> = {
  retry: "Run retried",
  pause: "Run paused",
  resume: "Run resumed",
  cancel: "Run cancelled",
};

/** A run's row Sheet: details, Retry / Pause / Resume / Cancel, and its step history. */
export function RunSheet({
  run,
  onOpenChange,
}: {
  run: RunListItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const act = useRunAction();
  const steps = useScheduledActionList(
    { runId: run?.id, sort: "scheduledFor:asc", limit: 50 },
    Boolean(run),
  );
  const history = steps.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Sheet open={Boolean(run)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        {run && (
          <>
            <SheetHeader className="border-b">
              <SheetTitle className="pr-6">
                {run.workflow.name} · V{run.version}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <StatusBadge value={run.status} />
                <span>{run.contact.name}</span>
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 p-4">
              <PropertyList
                items={[
                  {
                    id: "contact",
                    label: "Contact",
                    value: <RefLink type="contact" value={run.contact} />,
                  },
                  {
                    id: "workflow",
                    label: "Workflow",
                    value: (
                      <Link
                        to="/automations/workflows/$workflowId"
                        params={{ workflowId: run.workflow.id }}
                        className="hover:underline"
                      >
                        {run.workflow.name} · V{run.version}
                      </Link>
                    ),
                  },
                  { id: "step", label: "Current step", value: currentStepText(run) },
                  {
                    id: "started",
                    label: "Started",
                    value: <RelativeTime value={run.startedAt} />,
                  },
                  {
                    id: "next",
                    label: "Next action",
                    value: run.nextRunAt ? <RelativeTime value={run.nextRunAt} /> : null,
                  },
                  ...(run.completedAt
                    ? [
                        {
                          id: "completed",
                          label: "Completed",
                          value: <RelativeTime value={run.completedAt} />,
                        },
                      ]
                    : []),
                  ...(run.cancelledAt
                    ? [
                        {
                          id: "cancelled",
                          label: "Cancelled",
                          value: (
                            <>
                              <RelativeTime value={run.cancelledAt} />
                              {run.cancelReason ? ` · ${run.cancelReason}` : ""}
                            </>
                          ),
                        },
                      ]
                    : []),
                  ...(run.lastError
                    ? [
                        {
                          id: "error",
                          label: "Last error",
                          value: <span className="text-destructive">{run.lastError}</span>,
                        },
                      ]
                    : []),
                ]}
              />
              <div className="flex flex-wrap gap-2">
                {runActions(run.status).map(({ action, text }) => (
                  <Button
                    key={action}
                    size="sm"
                    variant="outline"
                    disabled={act.isPending}
                    onClick={() =>
                      act
                        .mutateAsync({ id: run.id, action })
                        .then(() => toast.success(DONE[action]))
                        .catch((error: unknown) => toast.error(messageFromError(error)))
                    }
                  >
                    {text}
                  </Button>
                ))}
              </div>
              <section aria-label="Step history" className="space-y-2">
                <h3 className="type-section-title">Step history</h3>
                {steps.isLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : steps.error ? (
                  <ErrorBlock error={steps.error} />
                ) : history.length === 0 ? (
                  <p className="type-body text-muted-foreground">No steps scheduled yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {history.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-start justify-between gap-2 rounded-md border px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="type-body">
                            {a.stepOrder != null ? `Step ${a.stepOrder + 1} · ` : ""}
                            {label(a.actionType)}
                          </div>
                          <div className="type-small text-muted-foreground">
                            <RelativeTime value={a.executedAt ?? a.scheduledFor} /> · attempts{" "}
                            {a.attemptCount}/{a.maxAttempts}
                          </div>
                          {(a.lastError || a.cancelReason) && (
                            <div className="type-small text-destructive">
                              {a.lastError ?? a.cancelReason}
                            </div>
                          )}
                        </div>
                        <StatusBadge value={a.status} />
                      </li>
                    ))}
                  </ul>
                )}
                {steps.hasNextPage && (
                  <Button size="sm" variant="ghost" onClick={() => void steps.fetchNextPage()}>
                    Load more
                  </Button>
                )}
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
