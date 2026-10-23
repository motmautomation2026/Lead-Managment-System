import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/common/status-badge";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import type {
  AgentDecisionDetail,
  AgentDecisionReport,
  AgentRatingReason,
} from "@/lib/backend-client";
import { label } from "@/lib/labels";
import { cn } from "@/lib/utils";
import {
  messageFromError,
  useAgentDecision,
  useIsAdmin,
  useRateDecision,
  useReportDecision,
  useResolveReport,
  useSession,
} from "@/store";
import {
  ACTION_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  RATING_REASON_LABEL,
  RATING_REASONS,
  istDateTime,
  usd,
} from "./agent-labels";

/** Right-hand drawer with one decision in full: message, checks, knowledge, rating, reports. */
export function DecisionDrawer({
  decisionId,
  onClose,
}: {
  decisionId: string | null;
  onClose: () => void;
}) {
  const query = useAgentDecision(decisionId);
  const d = query.data;
  return (
    <Dialog open={Boolean(decisionId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="left-auto right-0 top-0 h-dvh w-full max-w-xl translate-x-0 translate-y-0 content-start overflow-y-auto sm:rounded-none"
      >
        <DialogHeader>
          <DialogTitle>
            {d ? `${ACTION_LABEL[d.action]} for ${d.lead.name}` : "AI decision"}
          </DialogTitle>
        </DialogHeader>
        {query.isLoading ? (
          <LoadingBlock label="Loading decision…" />
        ) : query.error ? (
          <ErrorBlock error={query.error} />
        ) : d ? (
          <DecisionBody decision={d} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DecisionBody({ decision: d }: { decision: AgentDecisionDetail }) {
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/leads/$leadId"
          params={{ leadId: d.lead.id }}
          className="font-medium hover:underline"
        >
          {d.lead.name}
        </Link>
        <span className="text-muted-foreground">{d.lead.company}</span>
        <StatusBadge value="" display={OUTCOME_LABEL[d.outcome]} tone={OUTCOME_TONE[d.outcome]} />
        {d.regenerated && <StatusBadge value="" display="Regenerated" tone="warning" />}
        <span className="text-xs text-muted-foreground">{istDateTime(d.createdAt)}</span>
      </div>

      <Section title="Message">
        <DecisionMessage decision={d} />
      </Section>

      {d.error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive">
          {d.error}
        </p>
      )}

      <Section title="Why">
        <p className="whitespace-pre-wrap">{d.reasoning || "—"}</p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>Would send at</dt>
          <dd>{istDateTime(d.sendAt)}</dd>
          <dt>Next wake-up</dt>
          <dd>{istDateTime(d.nextWakeAt)}</dd>
        </dl>
      </Section>

      <Section title="Checks">
        <ChecksSummary rules={d.rulesResult} grounding={d.groundingResult} />
      </Section>

      <Section title="Knowledge used">
        {d.chunks.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <ul className="space-y-2">
            {d.chunks.map((c) => (
              <li key={c.id} className="rounded-md border p-2">
                {c.deleted ? (
                  <span className="text-muted-foreground">Deleted from the knowledge base</span>
                ) : (
                  <>
                    <div className="text-xs font-medium">{c.title}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{c.text}…</p>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <p className="text-xs text-muted-foreground">
        Models {d.decisionModel ?? "—"} / {d.groundingModel ?? "—"} · tokens {d.inputTokens ?? 0} in
        / {d.outputTokens ?? 0} out · cost {usd(d.costUsd)} · playbook v{d.playbookVersion ?? "—"} ·{" "}
        {d.regenerated ? "regenerated once" : "first attempt"}
      </p>

      <RatingControls
        key={`${d.id}-${d.ratedAt}`}
        decision={{ ...d, leadOwnerId: d.lead.ownerId }}
        ratedByName={d.ratedByName}
      />
      <ReportsSection key={d.id} decisionId={d.id} reports={d.reports} />
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

type MessageFields = Pick<
  AgentDecisionDetail,
  "action" | "messageSubject" | "messageBody" | "handoffTitle" | "newStage" | "stopReason"
> & {
  composed?: AgentDecisionDetail["composed"];
  handoffUrgency?: AgentDecisionDetail["handoffUrgency"];
};

/** The composed message when there is one; otherwise what the decision would do. */
export function DecisionMessage({ decision: d }: { decision: MessageFields }) {
  const box = "whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm";
  if (d.composed?.channel === "email")
    return (
      <div className={box}>
        <div className="mb-2 font-medium">Subject: {d.composed.subject}</div>
        {d.composed.text}
      </div>
    );
  if (d.composed?.channel === "whatsapp") return <div className={box}>{d.composed.text}</div>;
  if (d.action === "send_email" || d.action === "send_whatsapp")
    return (
      <div className={box}>
        {d.messageSubject && <div className="mb-2 font-medium">Subject: {d.messageSubject}</div>}
        {d.messageBody ?? "—"}
      </div>
    );
  return (
    <div className="space-y-2">
      {d.action === "handoff" && (
        <p>
          Hand off to the rep: <span className="font-medium">{d.handoffTitle}</span>
          {d.handoffUrgency && ` (${d.handoffUrgency} urgency)`}
        </p>
      )}
      {d.action === "update_stage" && (
        <p>
          Move to stage <span className="font-medium">{label(d.newStage)}</span>
        </p>
      )}
      {d.action === "stop" && (
        <p>
          Stop contacting this lead: <span className="font-medium">{label(d.stopReason)}</span>
        </p>
      )}
      {d.action === "wait" && <p>Wait and look again at the next wake-up.</p>}
      {d.action === "handoff" && d.messageBody && (
        <div>
          <p className="text-xs text-muted-foreground">The draft that failed the checks:</p>
          <div className={box}>{d.messageBody}</div>
        </div>
      )}
    </div>
  );
}

export function ChecksSummary({
  rules,
  grounding,
}: {
  rules: AgentDecisionDetail["rulesResult"];
  grounding: AgentDecisionDetail["groundingResult"];
}) {
  return (
    <div className="space-y-2">
      <div>
        <span className="font-medium">Rules: </span>
        {rules ? (rules.allowed ? "passed" : "blocked") : "not checked"}
        {rules && [...rules.violations, ...rules.adjustments].length > 0 && (
          <ul className="ml-4 list-disc text-xs">
            {rules.violations.map((v, i) => (
              <li key={`v${i}`} className="text-destructive">
                {v.message}
              </li>
            ))}
            {rules.adjustments.map((a, i) => (
              <li key={`a${i}`} className="text-muted-foreground">
                Adjusted: {a.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <span className="font-medium">Facts: </span>
        {grounding
          ? grounding.supported
            ? "every claim is supported"
            : "some claims aren't supported"
          : "not checked (only messages are)"}
        {grounding && grounding.unsupportedClaims.length > 0 && (
          <ul className="ml-4 list-disc text-xs text-destructive">
            {grounding.unsupportedClaims.map((c) => (
              <li key={c}>Unsupported: {c}</li>
            ))}
          </ul>
        )}
        {grounding?.ignoredClaims && grounding.ignoredClaims.length > 0 && (
          <ul className="ml-4 list-disc text-xs text-muted-foreground">
            {grounding.ignoredClaims.map((c) => (
              <li key={c}>Ignored (a company name): {c}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Good / Bad with a reason. Shown only to admins and the lead's owner, never on failed
 * decisions (the server enforces the same).
 */
export function RatingControls({
  decision,
  ratedByName,
}: {
  decision: Pick<
    AgentDecisionDetail,
    "id" | "outcome" | "rating" | "ratingReason" | "ratingNote"
  > & {
    leadOwnerId: string | null;
  };
  ratedByName?: string | null | undefined;
}) {
  const isAdmin = useIsAdmin();
  const { currentUser } = useSession();
  const rate = useRateDecision();
  const [rating, setRating] = useState<"good" | "bad" | null>(decision.rating);
  const [reason, setReason] = useState<AgentRatingReason | null>(decision.ratingReason);
  const [note, setNote] = useState(decision.ratingNote ?? "");

  const canRate =
    (isAdmin || (currentUser !== null && currentUser.id === decision.leadOwnerId)) &&
    decision.outcome !== "failed";
  if (!canRate) return null;

  const save = () =>
    rate.mutate(
      {
        id: decision.id,
        input: {
          rating: rating!,
          reason: rating === "bad" ? reason! : undefined,
          note: note.trim() || undefined,
        },
      },
      {
        onSuccess: () => toast.success("Rating saved"),
        onError: (error) => toast.error(messageFromError(error)),
      },
    );

  return (
    <Section title="Rating">
      {decision.rating && (
        <p className="mb-2 text-xs text-muted-foreground">
          Currently rated {decision.rating === "good" ? "Good" : "Bad"}
          {decision.ratingReason && ` (${RATING_REASON_LABEL[decision.ratingReason]})`}
          {ratedByName && ` by ${ratedByName}`}.
        </p>
      )}
      <div className="flex gap-2">
        {(["good", "bad"] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={rating === value ? "default" : "outline"}
            aria-pressed={rating === value}
            onClick={() => setRating(value)}
          >
            {value === "good" ? "Good" : "Bad"}
          </Button>
        ))}
      </div>
      {rating === "bad" && (
        <div className="mt-3">
          <Label className="mb-1.5 block text-xs">What was wrong? (required)</Label>
          <div className="flex flex-wrap gap-1.5">
            {RATING_REASONS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={reason === value}
                onClick={() => setReason(value)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs",
                  reason === value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "hover:bg-accent",
                )}
              >
                {RATING_REASON_LABEL[value]}
              </button>
            ))}
          </div>
        </div>
      )}
      <Textarea
        className="mt-3"
        rows={2}
        maxLength={2000}
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button
        size="sm"
        className="mt-2"
        disabled={!rating || (rating === "bad" && !reason) || rate.isPending}
        onClick={save}
      >
        Save rating
      </Button>
    </Section>
  );
}

/** Anyone can report a problem; admins resolve. */
export function ReportsSection({
  decisionId,
  reports,
}: {
  decisionId: string;
  reports: AgentDecisionReport[];
}) {
  const isAdmin = useIsAdmin();
  const report = useReportDecision();
  const [note, setNote] = useState("");
  const submit = () =>
    report.mutate(
      { id: decisionId, note: note.trim() },
      {
        onSuccess: () => {
          setNote("");
          toast.success("Problem reported. Admins have been notified.");
        },
        onError: (error) => toast.error(messageFromError(error)),
      },
    );
  return (
    <Section title="Report a problem">
      <Textarea
        rows={2}
        maxLength={2000}
        placeholder="What's wrong with this AI message?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        className="mt-2"
        disabled={!note.trim() || report.isPending}
        onClick={submit}
      >
        Report
      </Button>
      {reports.length > 0 && (
        <ul className="mt-3 space-y-2">
          {reports.map((r) => (
            <ReportItem key={r.id} report={r} canResolve={isAdmin} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ReportItem({
  report: r,
  canResolve,
}: {
  report: AgentDecisionReport;
  canResolve: boolean;
}) {
  const resolve = useResolveReport();
  const [note, setNote] = useState("");
  return (
    <li className="rounded-md border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{r.reportedByName ?? "Someone"}</span>
        <span className="text-muted-foreground">{istDateTime(r.createdAt)}</span>
        <StatusBadge
          value=""
          display={r.resolvedAt ? "Resolved" : "Open"}
          tone={r.resolvedAt ? "success" : "warning"}
        />
      </div>
      <p className="mt-1 whitespace-pre-wrap">{r.note}</p>
      {r.resolvedAt && (
        <p className="mt-1 text-muted-foreground">
          Resolved{r.resolvedByName ? ` by ${r.resolvedByName}` : ""}
          {r.resolutionNote ? `: ${r.resolutionNote}` : "."}
        </p>
      )}
      {!r.resolvedAt && canResolve && (
        <div className="mt-2 flex gap-2">
          <Input
            className="h-8"
            maxLength={2000}
            placeholder="Resolution note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            size="sm"
            disabled={resolve.isPending}
            onClick={() =>
              resolve.mutate(
                { reportId: r.id, note: note.trim() || undefined },
                {
                  onSuccess: () => toast.success("Report resolved"),
                  onError: (error) => toast.error(messageFromError(error)),
                },
              )
            }
          >
            Resolve
          </Button>
        </div>
      )}
    </li>
  );
}
