import { useMemo, useState } from "react";
import { Info, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/crm/page-header";
import { DataTable, type DataTableColumn } from "@/components/crm/data-table";
import { EmptyState } from "@/components/crm/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/common/status-badge";
import { ErrorBlock } from "@/components/common/server-state";
import type { AgentDecisionRow, AgentQualityStats } from "@/lib/backend-client";
import { usePrefetchRecord } from "@/features/crm/prefetch";
import { RefLink } from "@/features/work/ref-link";
import { useListUrlState } from "@/lib/use-list-url-state";
import { useAgentDecisions, useAgentStats } from "@/store";
import {
  aiActivitySearchSchema,
  toDecisionFilters,
  type AiActivitySearch,
} from "./ai-activity-search";
import {
  ACTION_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  RATING_REASON_LABEL,
  REPLY_LABEL_TEXT,
  istDateTime,
  usd,
} from "./agent-labels";
import { REPLY_LABELS } from "@/types";
import { DecisionDrawer } from "./decision-drawer";
import { LiveBanner, SendStatusPill } from "./live-mode";

// Display only: the server's go-live gate (agent/readiness.ts) decides readiness.
const MIN_RATED = 50;

/** E3a: how often the writer's message passes the checks on the first try, and what happens otherwise. */
function QualityStats({ title, stats }: { title: string; stats: AgentQualityStats }) {
  const reasons = Object.entries(stats.checkHandoffsByReason);
  return (
    <div className="space-y-1">
      <span className="text-sm font-medium">{title}</span>
      <div className="text-2xl font-semibold">
        Passed first try: {stats.passedFirstTryPct == null ? "—" : `${stats.passedFirstTryPct} %`}
      </div>
      <p className="text-xs text-muted-foreground">
        {stats.sendDecisions} {stats.sendDecisions === 1 ? "message" : "messages"} ·{" "}
        {stats.regenerated} regenerated · {stats.checkHandoffs} handed off by the checks ·{" "}
        {stats.autoFixes} fixed automatically · {usd(stats.avgCostUsd)} per decision
        {stats.cachedInputPct != null && ` · ${stats.cachedInputPct} % of input cached`}
      </p>
      {reasons.length > 0 && (
        <ul className="ml-4 list-disc text-xs text-muted-foreground">
          {reasons.map(([reason, n]) => (
            <li key={reason}>
              {reason}: {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AiActivityPage() {
  const stats = useAgentStats();
  const [state, set] = useListUrlState(aiActivitySearchSchema);
  const [selected, setSelected] = useState<string | null>(null);
  const prefetch = usePrefetchRecord();
  // "all" in a Select = the filter is absent from the URL.
  const pick = (key: "action" | "outcome" | "rating") => (value: string) =>
    void set({ [key]: value === "all" ? undefined : value } as Partial<AiActivitySearch>);

  const filters = useMemo(() => toDecisionFilters(state), [state]);
  const decisions = useAgentDecisions(filters);
  const rows = decisions.data?.pages.flatMap((page) => page.data) ?? [];
  const s = stats.data;

  return (
    <div className="pb-24">
      <PageHeader
        title="AI Activity"
        description="Everything the AI agent decided, for review. Rate drafts so we know when it's safe to go live."
      />
      <div className="space-y-4 px-4 pt-4 sm:px-6">
        {s?.mode === "shadow" && (
          <div className="flex items-center gap-2 rounded-md border border-info/40 bg-info-soft px-3 py-2 text-sm text-info-soft-foreground">
            <Info className="size-4 shrink-0" />
            Shadow mode: drafts only, nothing is sent to leads.
          </div>
        )}
        {s?.mode === "live" && s.live && <LiveBanner live={s.live} />}

        {stats.error ? (
          <ErrorBlock error={stats.error} />
        ) : (
          s && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <Card>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">Go-live readiness</span>
                    <StatusBadge
                      value=""
                      display={s.readiness.ready ? "Ready" : "Not ready"}
                      tone={s.readiness.ready ? "success" : "warning"}
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <Stat label="Rated" value={`${s.readiness.rated} / ${MIN_RATED}`} />
                    <Stat
                      label="Good"
                      value={s.readiness.goodPct == null ? "—" : `${s.readiness.goodPct} %`}
                    />
                    <Stat label="Serious problems" value={String(s.readiness.seriousBad)} />
                  </div>
                  {s.readiness.reasons.length > 0 && (
                    <ul className="ml-4 list-disc text-xs text-muted-foreground">
                      {s.readiness.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-1 p-4">
                  <span className="text-sm font-medium">This month's AI spend</span>
                  <div className="text-2xl font-semibold">
                    {usd(s.spend.spentUsd)}
                    <span className="text-sm font-normal text-muted-foreground">
                      {" "}
                      of {usd(s.spend.budgetUsd)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {s.failed} failed {s.failed === 1 ? "decision" : "decisions"} (not counted in
                    reviews)
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-1 p-4">
                  <span className="text-sm font-medium">Replies this month (WhatsApp + email)</span>
                  {Object.keys(s.replies.byLabel).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No replies labelled yet.</p>
                  ) : (
                    <ul className="space-y-0.5 text-sm">
                      {REPLY_LABELS.filter((l) => s.replies.byLabel[l]).map((l) => (
                        <li key={l} className="flex justify-between gap-2">
                          <span>{REPLY_LABEL_TEXT[l]}</span>
                          <span className="font-medium">{s.replies.byLabel[l]}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">
                    AI labelling cost {usd(s.replies.costUsd)} (included in the spend)
                  </p>
                </CardContent>
              </Card>
              <button
                type="button"
                className="text-left"
                onClick={() => void set({ openReport: true })}
                title="Show decisions with an open report"
              >
                <Card className="h-full transition-colors hover:bg-accent/40">
                  <CardContent className="space-y-1 p-4">
                    <span className="text-sm font-medium">Open reports</span>
                    <div className="text-2xl font-semibold">{s.openReports}</div>
                    <p className="text-xs text-muted-foreground">Click to show them</p>
                  </CardContent>
                </Card>
              </button>
              <Card className="md:col-span-2 xl:col-span-4">
                <CardContent className="grid gap-4 p-4 md:grid-cols-2">
                  <QualityStats
                    title="Since the go-live count started"
                    stats={s.quality.sinceReadiness}
                  />
                  <QualityStats title="Last 7 days" stats={s.quality.last7Days} />
                </CardContent>
              </Card>
            </div>
          )
        )}

        <div className="flex flex-wrap items-end gap-2">
          <Filter
            value={state.action ?? "all"}
            onChange={pick("action")}
            label="Action"
            options={[["all", "All actions"], ...Object.entries(ACTION_LABEL)]}
          />
          <Filter
            value={state.outcome ?? "all"}
            onChange={pick("outcome")}
            label="Outcome"
            options={[["all", "All outcomes"], ...Object.entries(OUTCOME_LABEL)]}
          />
          <Filter
            value={state.rating ?? "all"}
            onChange={pick("rating")}
            label="Rating"
            options={[
              ["all", "Any rating"],
              ["good", "Good"],
              ["bad", "Bad"],
              ["unrated", "Unrated"],
            ]}
          />
          <div>
            <Label htmlFor="ai-from" className="mb-1 block text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="ai-from"
              type="date"
              className="w-40"
              value={state.from ?? ""}
              onChange={(e) => void set({ from: e.target.value || undefined })}
            />
          </div>
          <div>
            <Label htmlFor="ai-to" className="mb-1 block text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="ai-to"
              type="date"
              className="w-40"
              value={state.to ?? ""}
              onChange={(e) => void set({ to: e.target.value || undefined })}
            />
          </div>
          <label className="flex h-9 items-center gap-2 text-sm">
            <Checkbox
              checked={state.openReport === true}
              onCheckedChange={(v) => void set({ openReport: v === true ? true : undefined })}
            />
            Has open report
          </label>
        </div>

        <DataTable<AgentDecisionRow>
          label="AI decisions"
          data={rows}
          columns={DECISION_COLUMNS}
          getRowId={(r) => r.id}
          onRowClick={(r) => setSelected(r.id)}
          onRowIntent={(r) => prefetch("contact", r.lead.id)}
          hasNextPage={decisions.hasNextPage}
          isFetchingNextPage={decisions.isFetchingNextPage}
          onLoadMore={() => void decisions.fetchNextPage()}
          isLoading={decisions.isLoading}
          error={decisions.error}
          onRetry={() => void decisions.refetch()}
          emptyState={
            <EmptyState
              icon={Sparkles}
              title="No AI decisions match these filters."
              text="Change the filters, or wait for the agent's next wake-up."
            />
          }
        />
      </div>
      <DecisionDrawer decisionId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function DecisionBadges({ row }: { row: AgentDecisionRow }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <StatusBadge value="" display={ACTION_LABEL[row.action]} tone="info" />
      <StatusBadge value="" display={OUTCOME_LABEL[row.outcome]} tone={OUTCOME_TONE[row.outcome]} />
      <SendStatusPill state={row} />
      {row.regenerated && <StatusBadge value="" display="Regenerated" tone="warning" />}
      {row.rating && (
        <StatusBadge
          value=""
          display={
            row.rating === "good"
              ? "Rated good"
              : `Rated bad${row.ratingReason ? `: ${RATING_REASON_LABEL[row.ratingReason]}` : ""}`
          }
          tone={row.rating === "good" ? "success" : "danger"}
        />
      )}
      {row.openReports > 0 && (
        <StatusBadge
          value=""
          display={`${row.openReports} open ${row.openReports === 1 ? "report" : "reports"}`}
          tone="danger"
        />
      )}
    </span>
  );
}

const DECISION_COLUMNS: DataTableColumn<AgentDecisionRow>[] = [
  {
    id: "createdAt",
    header: "When (IST)",
    size: 170,
    hideable: false,
    cell: (r) => (
      <span className="type-small text-muted-foreground">{istDateTime(r.createdAt)}</span>
    ),
  },
  {
    id: "contact",
    header: "Contact",
    cell: (r) => (
      <span className="min-w-0">
        <RefLink type="contact" value={{ id: r.lead.id, name: r.lead.name }} />
        <span className="block truncate type-small text-muted-foreground">{r.lead.company}</span>
      </span>
    ),
  },
  { id: "owner", header: "Owner", size: 150, cell: (r) => r.ownerName ?? "Unassigned" },
  { id: "decision", header: "Decision", size: 300, cell: (r) => <DecisionBadges row={r} /> },
  {
    id: "message",
    header: "Message",
    size: 320,
    cell: (r) => (
      <span className="min-w-0">
        {r.subject && <span className="block truncate font-medium">{r.subject}</span>}
        {r.bodyPreview && (
          <span className="block truncate type-small text-muted-foreground">{r.bodyPreview}</span>
        )}
      </span>
    ),
  },
];

function Filter({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  label: string;
}) {
  return (
    <div>
      <Label className="mb-1 block text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-44" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, text]) => (
            <SelectItem key={v} value={v}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
