import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/crm/relative-time";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/labels";
import { readPreference, writePreference } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import { messageFromError, useLeadSummary, useRefreshLeadSummary } from "@/store";
import type { LeadSummaryCard as Card } from "@/types";

const SUMMARY_COLLAPSED_KEY = "motmflow.leadSummaryCollapsed";

const AI_NOTICE: Partial<Record<NonNullable<Card["ai"]["status"]>, string>> = {
  paused_cap: "AI summary paused for today.",
  paused_budget: "AI summary paused: the monthly AI budget is used up.",
  off: "AI summary is off while the AI agent is off.",
  failed: "The AI summary could not be written. Try Refresh later.",
};

/** SUM-1: what the lead needs, what happened, where it stands, what next — quick facts always, the AI summary when ready. */
export function LeadSummaryCard({ contactId }: { contactId: string }) {
  const [collapsed, setCollapsed] = useState(
    () => readPreference(SUMMARY_COLLAPSED_KEY, ["1", "0"], "0") === "1",
  );
  const query = useLeadSummary(contactId);
  const refresh = useRefreshLeadSummary(contactId);
  const data = query.data;

  const toggle = () => {
    setCollapsed((value) => {
      writePreference(SUMMARY_COLLAPSED_KEY, value ? "0" : "1");
      return !value;
    });
  };
  const onRefresh = () =>
    refresh.mutate(undefined, {
      onSuccess: () => toast.success("Summary refresh queued. It updates in a minute or two."),
      onError: (error) => toast.error(messageFromError(error)),
    });
  const waiting = Boolean(
    data?.refreshAvailableAt && new Date(data.refreshAvailableAt).getTime() > Date.now(),
  );

  return (
    <section aria-label="Lead summary" className="rounded-lg border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 type-label"
        >
          <ChevronDown
            aria-hidden
            className={cn("size-4 transition-transform", collapsed && "-rotate-90")}
          />
          Lead summary
        </button>
        <div className="flex items-center gap-2 type-small text-muted-foreground">
          {data?.ai.generatedAt && (
            <span>
              Updated <RelativeTime value={data.ai.generatedAt} />
            </span>
          )}
          {data?.canRefresh && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onRefresh}
              disabled={refresh.isPending || waiting || data.ai.pending}
              title={waiting ? "Refreshed recently. Try again in a few minutes." : undefined}
            >
              <RefreshCw /> Refresh
            </Button>
          )}
        </div>
      </div>
      {!collapsed && <SummaryBody query={query} />}
    </section>
  );
}

function SummaryBody({ query }: { query: ReturnType<typeof useLeadSummary> }) {
  if (query.isPending) return <p className="mt-1 type-small text-muted-foreground">Loading…</p>;
  if (query.isError)
    return <p className="mt-1 type-small text-destructive">{messageFromError(query.error)}</p>;
  const { quickFacts: q, ai } = query.data;
  const notice = ai.status ? AI_NOTICE[ai.status] : undefined;
  return (
    <div className="mt-1 space-y-2 type-body">
      {ai.summary ? (
        <ul className="list-disc space-y-0.5 pl-5">
          <li>
            <span className="font-medium">Requirement:</span> {ai.summary.requirement}
          </li>
          <li>
            <span className="font-medium">So far:</span>{" "}
            {ai.summary.soFar.length ? ai.summary.soFar.join("; ") : "Not known"}
          </li>
          <li>
            <span className="font-medium">Status:</span> {ai.summary.status}
          </li>
          <li>
            <span className="font-medium">Next step:</span> {ai.summary.nextStep}
          </li>
        </ul>
      ) : (
        ai.pending && <p className="type-small text-muted-foreground">Writing the AI summary…</p>
      )}
      {notice && <p className="type-small text-warning-soft-foreground">{notice}</p>}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 type-small sm:grid-cols-2">
        <Fact term="Requirement" value={q.requirement ?? "Not known"} />
        <Fact
          term="Last call"
          value={q.lastCall ? `${label(q.lastCall.outcome)} · ${fmtDate(q.lastCall.at)}` : "None"}
        />
        <Fact
          term="Last message"
          value={
            q.lastMessage
              ? `${label(q.lastMessage.channel)} (${label(q.lastMessage.source)}) · ${fmtDate(q.lastMessage.at)}`
              : "None"
          }
        />
        <Fact
          term="Last reply"
          value={
            q.lastReply ? `${label(q.lastReply.channel)} · ${fmtDate(q.lastReply.at)}` : "None"
          }
        />
        <Fact
          term="Next step"
          value={q.nextStep ? `${q.nextStep.title} · ${fmtDate(q.nextStep.at)}` : "No next step"}
        />
      </dl>
    </div>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{term}:</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}
