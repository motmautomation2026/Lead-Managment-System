import { useState } from "react";
import { Radio } from "lucide-react";
import type {
  AgentLiveScope,
  AgentReadiness,
  AgentSendState,
  AgentStats,
} from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/common/status-badge";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorBlock } from "@/components/common/server-state";
import { useAgentLivePreview } from "@/store";
import {
  cancelReasonText,
  istDateTime,
  LIVE_SCOPE_LABEL,
  SEND_STATUS_LABEL,
  SEND_STATUS_TONE,
} from "./agent-labels";

// Display only: the server's go-live gate (agent/readiness.ts) decides.
const MIN_RATED = 50;

/** E2: the red "Live" banner (AI Activity, Settings → AI agent). */
export function LiveBanner({ live }: { live: NonNullable<AgentStats["live"]> }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground"
    >
      <Radio className="mt-0.5 size-4 shrink-0" />
      <span>
        <strong>Live:</strong> the AI sends real messages to {live.liveContacts}{" "}
        {live.liveContacts === 1 ? "contact" : "contacts"} ({LIVE_SCOPE_LABEL[live.scope]}).{" "}
        {live.sentToday} sent today, {live.sentThisMonth} this month. Other AI contacts get drafts
        only.
      </span>
    </div>
  );
}

/**
 * The go-live gate's numbers with pass / fail. E2f: `readinessSince` shows where the count
 * starts; `reset` (admins, Settings) adds "Reset go-live count" with a confirm.
 */
export function GatePanel({
  readiness,
  readinessSince,
  reset,
}: {
  readiness: AgentReadiness;
  readinessSince?: string | null;
  reset?: { onConfirm: () => void; pending: boolean };
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Go-live gate</span>
        <StatusBadge
          value=""
          display={readiness.ready ? "Passed" : "Not passed"}
          tone={readiness.ready ? "success" : "warning"}
        />
      </div>
      <dl className="grid grid-cols-3 gap-2 text-center text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Rated</dt>
          <dd className="font-medium">
            {readiness.rated} / {MIN_RATED}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Good</dt>
          <dd className="font-medium">
            {readiness.goodPct == null ? "—" : `${readiness.goodPct} %`}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Serious bad</dt>
          <dd className="font-medium">{readiness.seriousBad}</dd>
        </div>
      </dl>
      {readiness.reasons.length > 0 && (
        <ul className="ml-4 list-disc text-xs text-muted-foreground">
          {readiness.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {(readinessSince !== undefined || reset) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {readinessSince
              ? `Counting since ${istDateTime(readinessSince)}`
              : "Counting all ratings"}
          </span>
          {reset && (
            <Button
              size="sm"
              variant="outline"
              disabled={reset.pending}
              onClick={() => setConfirming(true)}
            >
              Reset go-live count
            </Button>
          )}
        </div>
      )}
      {reset && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Reset the go-live count?"
          description="Ratings before now stay saved but no longer count toward the go-live gate."
          confirmLabel="Reset go-live count"
          confirmVariant="default"
          disabled={reset.pending}
          onConfirm={() => {
            reset.onConfirm();
            setConfirming(false);
          }}
        />
      )}
    </div>
  );
}

/** Confirm a switch into Live or to a wider scope, with the gate and what will change. */
export function LiveConfirmDialog({
  scope,
  onOpenChange,
  onConfirm,
  pending,
}: {
  /** null = closed. */
  scope: AgentLiveScope | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (scope: AgentLiveScope) => void;
  pending: boolean;
}) {
  const preview = useAgentLivePreview(scope);
  const p = preview.data;
  return (
    <Dialog open={scope !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Go live: {scope ? LIVE_SCOPE_LABEL[scope] : ""}?</DialogTitle>
        </DialogHeader>
        {preview.error ? (
          <ErrorBlock error={preview.error} />
        ) : !p ? (
          <p className="text-sm text-muted-foreground">Checking…</p>
        ) : (
          <div className="space-y-3 text-sm">
            <GatePanel readiness={p.readiness} />
            <ul className="space-y-1">
              <li data-testid="live-contacts">
                <strong>{p.liveContacts}</strong> {p.liveContacts === 1 ? "contact" : "contacts"}{" "}
                will get real WhatsApp and email messages from the AI.
              </li>
              <li data-testid="runs-to-cancel">
                <strong>{p.workflowRunsToCancel}</strong> workflow{" "}
                {p.workflowRunsToCancel === 1 ? "run" : "runs"} will be cancelled (a live contact is
                never in a workflow).
              </li>
            </ul>
            {!p.allowed && p.message && <p className="text-destructive">{p.message}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending || !p?.allowed}
            onClick={() => scope && onConfirm(scope)}
          >
            Go live
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A live send's state (Queued / Sent / Send failed / Cancelled / Dry run) with its reason as a
 * tooltip or text. Nothing for drafts: their outcome badge already says "Draft — not sent".
 */
export function SendStatusPill({
  state,
  showReason = false,
}: {
  state: AgentSendState;
  showReason?: boolean;
}) {
  const status = state.sendStatus;
  if (!status) return null;
  const reason =
    status === "cancelled"
      ? cancelReasonText(state.cancelReason)
      : status === "failed" || status === "queued"
        ? state.sendError
        : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <StatusBadge
        value=""
        display={SEND_STATUS_LABEL[status]}
        tone={SEND_STATUS_TONE[status]}
        title={reason ?? undefined}
      />
      {showReason && reason && <span className="text-xs text-muted-foreground">{reason}</span>}
    </span>
  );
}
