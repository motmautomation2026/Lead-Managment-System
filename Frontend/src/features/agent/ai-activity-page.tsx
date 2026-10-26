import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Info } from "lucide-react";
import { PageHeader } from "@/app/app-shell";
import { Button } from "@/components/ui/button";
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
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import type {
  AgentAction,
  AgentDecisionFilters,
  AgentDecisionRow,
  AgentOutcome,
} from "@/lib/backend-client";
import { toIsoFromIst } from "@/lib/dates";
import { useAgentDecisions, useAgentStats } from "@/store";
import {
  ACTION_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  RATING_REASON_LABEL,
  istDateTime,
  usd,
} from "./agent-labels";
import { DecisionDrawer } from "./decision-drawer";

// Display only: the server's go-live gate (agent/readiness.ts) decides readiness.
const MIN_RATED = 50;

export function AiActivityPage() {
  const stats = useAgentStats();
  const [action, setAction] = useState("all");
  const [outcome, setOutcome] = useState("all");
  const [rating, setRating] = useState("all");
  const [openReport, setOpenReport] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const filters = useMemo<AgentDecisionFilters>(
    () => ({
      action: action === "all" ? undefined : (action as AgentAction),
      outcome: outcome === "all" ? undefined : (outcome as AgentOutcome),
      rating: rating === "all" ? undefined : (rating as AgentDecisionFilters["rating"]),
      hasOpenReport: openReport || undefined,
      // Whole IST days.
      from: from ? toIsoFromIst(from, "00:00:00") : undefined,
      to: to ? toIsoFromIst(to, "23:59:59") : undefined,
    }),
    [action, outcome, rating, openReport, from, to],
  );
  const decisions = useAgentDecisions(filters);
  const rows = decisions.data?.pages.flatMap((page) => page.data) ?? [];
  const s = stats.data;

  return (
    <div className="pb-10">
      <PageHeader
        title="AI Activity"
        description="Everything the AI agent decided, for review. Rate drafts so we know when it's safe to go live."
      />
      <div className="space-y-4 p-4 sm:p-6">
        {s?.mode === "shadow" && (
          <div className="flex items-center gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-sm">
            <Info className="size-4 shrink-0 text-info" />
            Shadow mode: drafts only, nothing is sent to leads.
          </div>
        )}

        {stats.error ? (
          <ErrorBlock error={stats.error} />
        ) : (
          s && (
            <div className="grid gap-3 md:grid-cols-3">
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
              <button
                type="button"
                className="text-left"
                onClick={() => setOpenReport(true)}
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
            </div>
          )
        )}

        <div className="flex flex-wrap items-end gap-2">
          <Filter
            value={action}
            onChange={setAction}
            label="Action"
            options={[["all", "All actions"], ...Object.entries(ACTION_LABEL)]}
          />
          <Filter
            value={outcome}
            onChange={setOutcome}
            label="Outcome"
            options={[["all", "All outcomes"], ...Object.entries(OUTCOME_LABEL)]}
          />
          <Filter
            value={rating}
            onChange={setRating}
            label="Rating"
            options={[
              ["all", "Any rating"],
              ["good", "Good"],
              ["bad", "Bad"],
              ["unrated", "Unrated"],
            ]}
          />
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">From</Label>
            <Input
              type="date"
              className="w-40"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">To</Label>
            <Input
              type="date"
              className="w-40"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <label className="flex h-9 items-center gap-2 text-sm">
            <Checkbox checked={openReport} onCheckedChange={(v) => setOpenReport(v === true)} />
            Has open report
          </label>
        </div>

        {decisions.isLoading ? (
          <LoadingBlock label="Loading AI decisions…" />
        ) : decisions.error ? (
          <ErrorBlock error={decisions.error} />
        ) : rows.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No AI decisions match these filters.
            </CardContent>
          </Card>
        ) : (
          <Card className="divide-y p-0">
            {rows.map((row) => (
              <DecisionListRow key={row.id} row={row} onOpen={() => setSelected(row.id)} />
            ))}
          </Card>
        )}
        {decisions.hasNextPage && (
          <div className="text-center">
            <Button
              variant="outline"
              disabled={decisions.isFetchingNextPage}
              onClick={() => void decisions.fetchNextPage()}
            >
              {decisions.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
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

function DecisionListRow({ row, onOpen }: { row: AgentDecisionRow; onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer space-y-1.5 px-4 py-3 text-sm hover:bg-accent/40"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs text-muted-foreground">{istDateTime(row.createdAt)}</span>
        <Link
          to="/contacts/$contactId"
          params={{ contactId: row.lead.id }}
          className="font-medium hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {row.lead.name}
        </Link>
        <span className="text-xs text-muted-foreground">{row.lead.company}</span>
        <span className="text-xs text-muted-foreground">
          Owner: {row.ownerName ?? "Unassigned"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge value="" display={ACTION_LABEL[row.action]} tone="info" />
        <StatusBadge
          value=""
          display={OUTCOME_LABEL[row.outcome]}
          tone={OUTCOME_TONE[row.outcome]}
        />
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
      </div>
      {row.subject && <div className="font-medium">{row.subject}</div>}
      {row.bodyPreview && (
        <p className="line-clamp-2 text-xs text-muted-foreground">{row.bodyPreview}</p>
      )}
    </div>
  );
}

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
