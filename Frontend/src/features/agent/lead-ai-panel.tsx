import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/common/status-badge";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import type { LeadAgentPanel } from "@/lib/backend-client";
import {
  messageFromError,
  useEnrollLeads,
  useIsAdmin,
  useLeadAgentPanel,
  usePauseLead,
  useResumeLead,
  useStopLead,
  useWakeLead,
} from "@/store";
import {
  ACTION_LABEL,
  AGENT_STATUS_LABEL,
  AGENT_STATUS_TONE,
  ENROLL_SKIP_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  RATING_REASON_LABEL,
  istDateTime,
  statusReasonLabel,
  wakeReasonLabel,
} from "./agent-labels";
import { ChecksSummary, DecisionDrawer, DecisionMessage, Section } from "./decision-drawer";

type ConfirmAction = "pause" | "resume" | "stop";
const CONFIRM_TEXT: Record<ConfirmAction, { title: string; body: string }> = {
  pause: { title: "Pause the AI agent?", body: "It stops writing for this lead until resumed." },
  resume: { title: "Resume the AI agent?", body: "It looks at this lead again right away." },
  stop: {
    title: "Stop the AI agent?",
    body: "It stops working on this lead. An admin can enroll the lead again later.",
  },
};

/** The lead page's AI tab: agent status, next wake-up, admin controls and the last 10 decisions. */
export function LeadAiPanel({ leadId }: { leadId: string }) {
  const panel = useLeadAgentPanel(leadId);
  const isAdmin = useIsAdmin();
  const [openDecision, setOpenDecision] = useState<string | null>(null);

  if (panel.isLoading) return <LoadingBlock label="Loading AI agent…" />;
  if (panel.error) return <ErrorBlock error={panel.error} />;
  const p = panel.data;
  if (!p) return null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            AI agent
            <StatusBadge
              value=""
              display={p.status === "none" ? "Not enrolled" : AGENT_STATUS_LABEL[p.status]}
              tone={AGENT_STATUS_TONE[p.status]}
            />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {statusReasonLabel(p.statusReason) && (
            <p className="text-muted-foreground">
              {statusReasonLabel(p.statusReason)}
              {p.statusChangedAt && ` · ${istDateTime(p.statusChangedAt)}`}
            </p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Touches used</dt>
            <dd>{p.touchCount}</dd>
            <dt className="text-muted-foreground">Last touch</dt>
            <dd>{istDateTime(p.lastTouchAt)}</dd>
            <dt className="text-muted-foreground">Next wake-up</dt>
            <dd>
              {p.nextWakeup
                ? `${istDateTime(p.nextWakeup.dueAt)} · ${wakeReasonLabel(p.nextWakeup.reason)}`
                : "None scheduled"}
            </dd>
          </dl>
          {isAdmin && <AdminControls panel={p} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Last {p.decisions.length || ""} AI decisions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {p.decisions.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No AI decisions yet.</p>
          ) : (
            <ul className="divide-y">
              {p.decisions.map((d) => (
                <PanelDecision key={d.id} decision={d} onOpen={() => setOpenDecision(d.id)} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <DecisionDrawer decisionId={openDecision} onClose={() => setOpenDecision(null)} />
    </div>
  );
}

function PanelDecision({
  decision: d,
  onOpen,
}: {
  decision: LeadAgentPanel["decisions"][number];
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="px-4 py-3 text-sm">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-2 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <span className="text-xs text-muted-foreground">{istDateTime(d.createdAt)}</span>
        <StatusBadge value="" display={ACTION_LABEL[d.action]} tone="info" />
        <StatusBadge value="" display={OUTCOME_LABEL[d.outcome]} tone={OUTCOME_TONE[d.outcome]} />
        {d.rating && (
          <StatusBadge
            value=""
            display={d.rating === "good" ? "Rated good" : "Rated bad"}
            tone={d.rating === "good" ? "success" : "danger"}
          />
        )}
        {d.openReports > 0 && (
          <StatusBadge value="" display={`${d.openReports} open report(s)`} tone="danger" />
        )}
        {d.messageSubject && <span className="font-medium">{d.messageSubject}</span>}
      </button>
      {expanded && (
        <div className="mt-3 space-y-3 pl-6">
          <DecisionMessage decision={d} />
          {d.error && <p className="text-destructive">{d.error}</p>}
          <Section title="Why">
            <p className="whitespace-pre-wrap">{d.reasoning || "—"}</p>
          </Section>
          <Section title="Checks">
            <ChecksSummary rules={d.rules} grounding={d.grounding} />
          </Section>
          {d.rating && (
            <p className="text-xs text-muted-foreground">
              Rated {d.rating === "good" ? "Good" : "Bad"}
              {d.ratingReason && ` (${RATING_REASON_LABEL[d.ratingReason]})`}
              {d.ratingNote && `: ${d.ratingNote}`}
            </p>
          )}
          <Button size="sm" variant="outline" onClick={onOpen}>
            Details, rate or report
          </Button>
        </div>
      )}
    </li>
  );
}

/** Admin only (the server enforces it); which buttons show mirrors the status for convenience. */
function AdminControls({ panel: p }: { panel: LeadAgentPanel }) {
  const enroll = useEnrollLeads();
  const pause = usePauseLead();
  const resume = useResumeLead();
  const stop = useStopLead();
  const wake = useWakeLead();
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [note, setNote] = useState("");
  const busy = [enroll, pause, resume, stop, wake].some((m) => m.isPending);
  const fail = (error: unknown) => toast.error(messageFromError(error));

  const runEnroll = async () => {
    try {
      const [result] = await enroll.mutateAsync([p.leadId]);
      if (result?.result === "enrolled") toast.success("Enrolled in the AI agent");
      else if (result?.result === "skipped")
        toast.error(`Not enrolled: ${ENROLL_SKIP_LABEL[result.reason]}`);
      else toast.error("Couldn't enroll this lead.");
    } catch (error) {
      fail(error);
    }
  };
  const runConfirmed = async () => {
    const action = confirm!;
    try {
      if (action === "pause") await pause.mutateAsync(p.leadId);
      else if (action === "resume") await resume.mutateAsync(p.leadId);
      else await stop.mutateAsync({ leadId: p.leadId, note: note.trim() || undefined });
      toast.success(
        { pause: "AI agent paused", resume: "AI agent resumed", stop: "AI agent stopped" }[action],
      );
      setConfirm(null);
      setNote("");
    } catch (error) {
      fail(error);
    }
  };

  return (
    <div className="flex flex-wrap gap-2 border-t pt-3">
      {(p.status === "none" || p.status === "stopped") && (
        <Button size="sm" disabled={busy} onClick={() => void runEnroll()}>
          Enroll
        </Button>
      )}
      {p.status === "active" && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("pause")}>
          Pause
        </Button>
      )}
      {(p.status === "paused" || p.status === "handed_off") && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("resume")}>
          Resume
        </Button>
      )}
      {(p.status === "active" || p.status === "paused" || p.status === "handed_off") && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("stop")}>
          Stop
        </Button>
      )}
      {p.status === "active" && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            wake.mutate(p.leadId, {
              onSuccess: () => toast.success("The AI agent will look at this lead now"),
              onError: fail,
            })
          }
        >
          Wake now
        </Button>
      )}

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{confirm && CONFIRM_TEXT[confirm].title}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{confirm && CONFIRM_TEXT[confirm].body}</p>
          {confirm === "stop" && (
            <div>
              <Label className="mb-1.5 block text-xs">Note (optional)</Label>
              <Textarea
                rows={2}
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirm === "stop" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void runConfirmed()}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
