import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { backend, type SystemHealth } from "@/lib/backend-client";
import { keys } from "@/store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusPill } from "@/components/crm/status-pill";

const RED_TEXT: Record<SystemHealth["workspaces"][number]["red"][number], string> = {
  stuck_queue: "Stuck queue",
  paused_channel: "Paused channel",
  ai_budget: "AI budget ≥ 90 %",
};

const age = (seconds: number | null) =>
  seconds === null
    ? "never"
    : seconds < 90
      ? `${seconds} s ago`
      : seconds < 5400
        ? `${Math.round(seconds / 60)} min ago`
        : `${Math.round(seconds / 3600)} h ago`;

const loopName = (loop: string) => loop.replaceAll("_", " ");

/**
 * Settings → System health (P7, super-admins only): each worker loop's heartbeat and, per workspace,
 * the send queues (stuck vs waiting for the window / spacing / warm-up), overdue AI wake-ups, paused
 * channels, failed sends and the AI budget and daily cap. Read-only; refreshes every 30 s.
 */
export function SystemHealthPanel() {
  const health = useQuery({
    queryKey: keys.systemHealth,
    queryFn: ({ signal }) => backend.superAdmin.systemHealth(signal),
    refetchInterval: 30_000,
  });

  if (health.isPending) return <LoadingBlock />;
  if (health.isError) return <ErrorBlock error={health.error} />;
  const data = health.data;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              Worker
              <StatusPill tone={data.status === "ok" ? "success" : "danger"} dot>
                {data.status === "ok" ? "Running" : "Stale"}
              </StatusPill>
            </CardTitle>
            <CardDescription>
              Each loop&rsquo;s last finished run. A loop is stale when it hasn&rsquo;t finished
              within 3× its expected interval; critical stale loops make <code>/health/worker</code>{" "}
              answer 503.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void health.refetch()}
            disabled={health.isFetching}
          >
            <RefreshCw className="size-4" aria-hidden />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {data.loops.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No heartbeats yet"
              text="Start the worker; every loop reports after its first tick."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Loop</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Last finished</th>
                    <th className="py-2 pr-3 text-right font-medium">Items</th>
                    <th className="py-2 font-medium">Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.loops.map((l) => {
                    const stale = l.ageSeconds === null || l.ageSeconds > l.expectedSeconds * 3;
                    return (
                      <tr key={l.loop} className="border-t">
                        <td className="py-2 pr-3 capitalize">
                          {loopName(l.loop)}
                          {!l.critical && (
                            <span className="ml-1 text-xs text-muted-foreground">(background)</span>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          <StatusPill
                            tone={
                              stale
                                ? l.critical
                                  ? "danger"
                                  : "warning"
                                : l.lastError
                                  ? "warning"
                                  : "success"
                            }
                            dot
                          >
                            {stale ? "Stale" : l.lastError ? "Error" : "OK"}
                          </StatusPill>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">{age(l.ageSeconds)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{l.itemsProcessed}</td>
                        <td className="py-2 text-muted-foreground">{l.lastError ?? "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>
            Stuck = due for more than 15 minutes; waiting = held for the send window, spacing,
            warm-up, a pause or a retry. Admins get one notification a day per red problem.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.workspaces.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No active workspaces"
              text="Create a workspace in All workspaces."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Workspace</th>
                    <th className="py-2 pr-3 text-right font-medium">Email stuck / waiting</th>
                    <th className="py-2 pr-3 text-right font-medium">WhatsApp stuck / waiting</th>
                    <th className="py-2 pr-3 text-right font-medium">Overdue AI wake-ups</th>
                    <th className="py-2 pr-3 font-medium">Paused</th>
                    <th className="py-2 pr-3 text-right font-medium">Failed 24 h</th>
                    <th className="py-2 pr-3 text-right font-medium">AI budget</th>
                    <th className="py-2 text-right font-medium">Decisions today</th>
                  </tr>
                </thead>
                <tbody>
                  {data.workspaces.map((w) => (
                    <tr key={w.workspaceId} className="border-t align-top">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{w.name}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {w.red.length === 0 ? (
                            <StatusPill tone="success" dot>
                              OK
                            </StatusPill>
                          ) : (
                            w.red.map((p) => (
                              <StatusPill key={p} tone="danger" dot>
                                {RED_TEXT[p]}
                              </StatusPill>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        <span className={w.emailStuck ? "font-medium text-destructive" : undefined}>
                          {w.emailStuck}
                        </span>{" "}
                        / {w.emailWaiting}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        <span
                          className={w.whatsappStuck ? "font-medium text-destructive" : undefined}
                        >
                          {w.whatsappStuck}
                        </span>{" "}
                        / {w.whatsappWaiting}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{w.overdueWakeups}</td>
                      <td className="py-2 pr-3">
                        {w.pausedNumbers === 0 && !w.emailPaused
                          ? "–"
                          : [
                              w.pausedNumbers ? `${w.pausedNumbers} number(s)` : null,
                              w.emailPaused ? "email" : null,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{w.failedSends24h}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{w.budgetUsedPct} %</td>
                      <td className="py-2 text-right tabular-nums">
                        {w.decisionsToday} / {w.decisionCap} ({w.decisionCapUsedPct} %)
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
