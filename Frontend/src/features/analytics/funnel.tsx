import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/crm/empty-state";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import type { Funnel, FunnelGroupBy } from "@/lib/backend-client";
import { toIsoFromIst } from "@/lib/dates";
import { label } from "@/lib/labels";
import { useFunnel } from "@/store";

const pct = (v: number | null | undefined) => (v == null ? "—" : `${v} %`);
const mins = (v: number | null | undefined) =>
  v == null ? "—" : v < 60 ? `${v} min` : `${Math.round((v / 60) * 10) / 10} h`;

/** The plain funnel steps (no chart library): new leads → contacted → replied → meeting → proposal → won. */
function FunnelSteps({ totals }: { totals: Funnel["totals"] }) {
  const steps: [string, number][] = [
    ["New leads", totals.leadsCreated],
    ["Contacted", totals.contacted],
    ["Replied", totals.replies],
    ["Meeting within 14 days", totals.meetingsBookedWithin14Days],
    ["Proposal", totals.proposals],
    ["Won", totals.won],
  ];
  const max = Math.max(1, totals.leadsCreated);
  return (
    <ul className="space-y-1.5" aria-label="Funnel">
      {steps.map(([name, n]) => (
        <li key={name} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-2 text-sm">
          <span className="truncate text-muted-foreground">{name}</span>
          <span className="h-2 rounded-full bg-muted">
            <span
              className="block h-2 rounded-full bg-primary"
              style={{ width: `${(n / max) * 100}%` }}
            />
          </span>
          <span className="num text-right font-medium">{n}</span>
        </li>
      ))}
    </ul>
  );
}

/** Home: "Conversion (last 30 days)" with the main number and the plain funnel. */
export function ConversionCard() {
  const funnel = useFunnel({});
  const data = funnel.data;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="type-section-title">Conversion (last 30 days)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {funnel.error ? (
          <ErrorBlock error={funnel.error} />
        ) : !data ? (
          <LoadingBlock />
        ) : data.totals.leadsCreated === 0 ? (
          <p className="text-sm text-muted-foreground">No new leads in the last 30 days.</p>
        ) : (
          <>
            <div>
              <div className="num text-2xl font-semibold">{pct(data.websiteMeetingRate.pct)}</div>
              <p className="type-small text-muted-foreground">
                of new website leads booked a meeting within 14 days (
                {data.websiteMeetingRate.bookedWithin14Days} of{" "}
                {data.websiteMeetingRate.websiteLeads})
              </p>
            </div>
            <FunnelSteps totals={data.totals} />
            <Link
              to="/ai-activity"
              search={{ tab: "results" }}
              className="type-small text-primary hover:underline"
            >
              See results
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const GROUPS: [FunnelGroupBy, string][] = [
  ["source", "Lead source"],
  ["channel", "Channel"],
  ["number", "WhatsApp number"],
  ["angle", "Message purpose"],
];

type Group = Funnel["groups"][number];
const n = (v: number | undefined) => String(v ?? 0);
const LEAD_COLUMNS: [(g: Group) => string, string][] = [
  [(g) => n(g.leadsCreated), "New leads"],
  [(g) => n(g.contacted), "Contacted"],
  [
    (g) => `${n(g.firstMessageWithin15Min?.count)} (${pct(g.firstMessageWithin15Min?.pct)})`,
    "First message ≤ 15 min",
  ],
  [(g) => mins(g.medianMinutesToFirstMessage), "Median to first message"],
  [(g) => n(g.emailsSent), "Emails sent"],
  [(g) => n(g.countedOpens), "Opens (soft)"],
  [(g) => n(g.replies), "Replies"],
  [(g) => n(g.positiveReplies), "Positive"],
  [(g) => n(g.meetingsBookedWithin14Days), "Meetings ≤ 14 days"],
  [(g) => n(g.proposals), "Proposals"],
  [(g) => n(g.won), "Won"],
];
const MESSAGE_COLUMNS: [(g: Group) => string, string][] = [
  [(g) => n(g.messagesSent), "Messages sent"],
  [(g) => n(g.emailsSent), "Emails"],
  [(g) => n(g.countedOpens), "Opens (soft)"],
  [(g) => n(g.replies), "Replies"],
  [(g) => n(g.positiveReplies), "Positive"],
  [(g) => n(g.meetingsBooked), "Meetings"],
  [(g) => n(g.dealsCreated), "Deals"],
  [(g) => n(g.won), "Won"],
];

/** AI Activity → Results: a date range (IST days), a group-by and a plain table. */
export function FunnelResults() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [groupBy, setGroupBy] = useState<FunnelGroupBy>("source");
  const funnel = useFunnel({
    from: from ? toIsoFromIst(from, "00:00:00") : undefined,
    to: to ? toIsoFromIst(to, "23:59:59") : undefined,
    groupBy,
  });
  const data = funnel.data;
  const byLead = groupBy === "source";
  const columns = byLead ? LEAD_COLUMNS : MESSAGE_COLUMNS;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="results-from" className="mb-1 block text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="results-from"
            type="date"
            className="w-40"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="results-to" className="mb-1 block text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="results-to"
            type="date"
            className="w-40"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="results-group" className="mb-1 block text-xs text-muted-foreground">
            Group by
          </Label>
          <Select value={groupBy} onValueChange={(v) => setGroupBy(v as FunnelGroupBy)}>
            <SelectTrigger id="results-group" className="w-44" aria-label="Group by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GROUPS.map(([value, text]) => (
                <SelectItem key={value} value={value}>
                  {text}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="pb-2 text-xs text-muted-foreground">
          Default: the last 30 days; at most 180 days.
        </p>
      </div>

      {funnel.error ? (
        <ErrorBlock error={funnel.error} />
      ) : !data ? (
        <LoadingBlock />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Tile
              name="Website leads with a meeting in 14 days"
              value={pct(data.websiteMeetingRate.pct)}
            />
            <Tile
              name="First message within 15 min"
              value={`${data.totals.firstMessageWithin15Min.count} (${pct(data.totals.firstMessageWithin15Min.pct)})`}
            />
            <Tile
              name="Median time to first message"
              value={mins(data.totals.medianMinutesToFirstMessage)}
            />
            <Tile
              name="Median time from a reply to our answer"
              value={mins(data.medianMinutesReplyToAnswer)}
            />
          </div>
          {data.groups.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title={byLead ? "No new leads in this period" : "No messages sent in this period"}
              text="Pick another period or group."
            />
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">
                      {GROUPS.find(([g]) => g === groupBy)![1]}
                    </th>
                    {columns.map(([, head]) => (
                      <th key={head} className="px-3 py-2 text-right font-medium">
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((g) => (
                    <tr key={g.key ?? "none"} className="border-t">
                      <td className="px-3 py-2">
                        {byLead ? label(g.key ?? "other") : (g.label ?? "—")}
                      </td>
                      {columns.map(([cell, head]) => (
                        <td key={head} className="num px-3 py-2 text-right">
                          {cell(g)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Opens are a soft signal: some mail apps load images without the email being read.
            Message numbers count only messages sent since per-message tracking started.
          </p>
        </>
      )}
    </div>
  );
}

function Tile({ name, value }: { name: string; value: string }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <div className="text-xs text-muted-foreground">{name}</div>
        <div className="num text-xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}
