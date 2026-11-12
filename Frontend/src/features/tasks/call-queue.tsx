import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ArrowLeft, Pause, Phone, Play, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/crm/page-header";
import { EmptyState } from "@/components/crm/empty-state";
import { PropertyList } from "@/components/crm/property-list";
import { RelativeTime } from "@/components/crm/relative-time";
import { SectionSkeleton } from "@/components/crm/section-skeleton";
import { ErrorBlock } from "@/components/common/server-state";
import { keysAreTaken } from "@/app/shortcuts";
import { AGENT_STATUS_LABEL } from "@/features/agent/agent-labels";
import { hotReasonText } from "@/features/contacts/hot-score-labels";
import { HotScorePill } from "@/features/contacts/hot-score";
import { ActivityFeed } from "@/features/crm/activity-feed";
import { EnrollWorkflowDialog } from "@/features/leads/scheduled-followups";
import { LogCallFlow } from "@/features/work/log-call-flow";
import type { LogCallInput } from "@/lib/backend-client";
import { dateInputValue } from "@/lib/dates";
import { toastUndo } from "@/lib/toast-undo";
import {
  messageFromError,
  useContact,
  useLeadMutations,
  useSession,
  useTaskCount,
  useTaskList,
} from "@/store";
import type { TaskListItem, WorkflowTrigger } from "@/types";
import { UNDO_MS, callQueueParams } from "./queue-params";

type Outcome = "connected" | "no_answer" | "busy" | "wrong_number" | "callback";
const OUTCOMES: Array<{ id: Outcome; key: string; label: string }> = [
  { id: "connected", key: "1", label: "Connected" },
  { id: "no_answer", key: "2", label: "No answer" },
  { id: "busy", key: "3", label: "Busy" },
  { id: "wrong_number", key: "4", label: "Wrong number" },
  { id: "callback", key: "5", label: "Call back at…" },
];

interface Progress {
  day: string;
  skipped: string[];
  done: number;
  paused: boolean;
}

/** Per user and IST day in this browser (try/catch): leaving and coming back resumes. */
function useProgress(userId: string) {
  const key = `motmflow.callQueue.${userId}`;
  const today = dateInputValue(0);
  const fresh: Progress = { day: today, skipped: [], done: 0, paused: false };
  const [progress, setProgress] = useState<Progress>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(key) ?? "null") as Progress | null;
      return saved?.day === today ? { ...fresh, ...saved } : fresh;
    } catch {
      return fresh;
    }
  });
  const update = useCallback(
    (patch: (p: Progress) => Partial<Progress>) =>
      setProgress((p) => {
        const next = { ...p, ...patch(p) };
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Storage unavailable: progress lasts for this visit only.
        }
        return next;
      }),
    [key],
  );
  return [progress, update] as const;
}

/**
 * UX-2 call queue ("Start calling"): one task at a time with the contact's key facts and the
 * outcome buttons. An outcome logs the call through POST /leads/:id/calls with the task id — the
 * backend completes the task and creates the follow-up by the existing call rules — after the
 * Undo window; meanwhile the next task is already on screen.
 */
export function CallQueuePage() {
  const { currentUser } = useSession();
  const [progress, setProgress] = useProgress(currentUser?.id ?? "anon");
  const params = useMemo(callQueueParams, []);
  const list = useTaskList(params);
  const remaining = useTaskCount(params);
  const { logCall } = useLeadMutations();

  // Outcomes waiting out their Undo window: hidden from the queue, sent when the timer fires.
  const [pending, setPending] = useState<Record<string, true>>({});
  // Logged: stays hidden even before the list refetch drops it (no flicker back).
  const [sent, setSent] = useState<Record<string, true>>({});
  const timers = useRef(new Map<string, { timer: number; send: () => void }>());
  const [enroll, setEnroll] = useState<{ leadId: string; trigger: WorkflowTrigger } | null>(null);
  const [connected, setConnected] = useState<{ task: TaskListItem; open: boolean } | null>(null);
  const [note, setNote] = useState("");
  const [callbackOpen, setCallbackOpen] = useState(false);
  const [callbackAt, setCallbackAt] = useState("");

  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  const queue = rows.filter(
    (t) => !pending[t.id] && !sent[t.id] && !progress.skipped.includes(t.id),
  );
  const task = queue[0] ?? null;
  const next = queue[1] ?? null;

  // Every loaded task skipped or pending but more exist: load the next page (one at a time).
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    if (!task && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [task, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Leaving the page sends what is still waiting (nothing is lost); closing the tab asks first.
  useEffect(() => {
    const map = timers.current;
    const warn = (e: BeforeUnloadEvent) => {
      if (map.size > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      for (const { timer, send } of map.values()) {
        window.clearTimeout(timer);
        send();
      }
      map.clear();
    };
  }, []);

  const reset = () => {
    setNote("");
    setCallbackOpen(false);
    setCallbackAt("");
  };

  const record = (t: TaskListItem, input: LogCallInput, label: string) => {
    const unhide = () =>
      setPending((p) => {
        const { [t.id]: _gone, ...rest } = p;
        return rest;
      });
    const send = () => {
      timers.current.delete(t.id);
      logCall(t.contact.id, { ...input, taskId: t.id }).then(
        (result) => {
          setProgress((p) => ({ done: p.done + 1 }));
          setSent((d) => ({ ...d, [t.id]: true }));
          unhide();
          if (result.workflowTrigger) {
            const trigger = result.workflowTrigger;
            toast(`${t.contact.name}: choose a nurture workflow?`, {
              action: {
                label: "Choose",
                onClick: () => setEnroll({ leadId: t.contact.id, trigger }),
              },
            });
          }
        },
        (error: unknown) => {
          unhide();
          toast.error(`${t.contact.name}: ${messageFromError(error)}`);
        },
      );
    };
    setPending((p) => ({ ...p, [t.id]: true }));
    timers.current.set(t.id, { timer: window.setTimeout(send, UNDO_MS), send });
    toastUndo(
      `${label} logged for ${t.contact.name || "the contact"}`,
      () => {
        const entry = timers.current.get(t.id);
        if (!entry) return;
        window.clearTimeout(entry.timer);
        timers.current.delete(t.id);
        unhide();
      },
      UNDO_MS,
    );
    reset();
  };

  const notes = () => note.trim() || undefined;
  const choose = (outcome: Outcome) => {
    if (!task || progress.paused) return;
    if (outcome === "connected") return setConnected({ task, open: true });
    if (outcome === "callback") return setCallbackOpen(true);
    record(
      task,
      { connected: false, notConnectedReason: outcome, notes: notes() },
      OUTCOMES.find((o) => o.id === outcome)!.label,
    );
  };
  const saveCallback = () => {
    if (!task || !callbackAt) return;
    const when = new Date(callbackAt);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now())
      return void toast.error("Pick a time in the future.");
    record(
      task,
      {
        connected: true,
        connectedOutcome: "callback_requested",
        callbackDueAt: when.toISOString(),
        notes: notes(),
      },
      "Call back",
    );
  };
  const skip = () => {
    if (!task) return;
    setProgress((p) => ({ skipped: [...p.skipped, task.id] }));
    reset();
  };
  const togglePause = () => setProgress((p) => ({ paused: !p.paused }));

  // 1–5 outcomes, s skip, p pause — never while typing or with a dialog open.
  const handlers = useRef({ choose, skip, togglePause });
  handlers.current = { choose, skip, togglePause };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || keysAreTaken(e.target))
        return;
      const outcome = OUTCOMES.find((o) => o.key === e.key);
      if (outcome) handlers.current.choose(outcome.id);
      else if (e.key === "s") handlers.current.skip();
      else if (e.key === "p") handlers.current.togglePause();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const left = (remaining.data?.count ?? 0) - Object.keys(pending).length;
  const total = progress.done + Math.max(left, 0);
  const position = Math.min(progress.done + 1, Math.max(total, 1));

  const header = (
    <PageHeader
      title="Call queue"
      description="My call and follow-up tasks due today or overdue, hottest first."
      actions={
        <Button asChild variant="outline">
          <Link to="/tasks">
            <ArrowLeft /> Tasks
          </Link>
        </Button>
      }
      primaryAction={
        <Button variant="outline" onClick={togglePause} disabled={!task && !progress.paused}>
          {progress.paused ? <Play /> : <Pause />} {progress.paused ? "Resume" : "Pause queue"}
        </Button>
      }
    />
  );

  let body;
  if (list.isLoading) body = <SectionSkeleton />;
  else if (list.error && rows.length === 0) body = <ErrorBlock error={list.error} />;
  else if (progress.paused)
    body = (
      <EmptyState
        icon={Pause}
        title="Queue paused"
        text={`You've worked ${progress.done} task${progress.done === 1 ? "" : "s"} today.`}
        action={<Button onClick={togglePause}>Resume</Button>}
      />
    );
  else if (!task)
    body =
      progress.skipped.length > 0 && rows.length > 0 ? (
        <EmptyState
          icon={SkipForward}
          title="Only skipped tasks left"
          text={`${progress.skipped.length} skipped today.`}
          action={
            <Button onClick={() => setProgress(() => ({ skipped: [] }))}>
              Go through them again
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={Phone}
          title="No calls waiting"
          text="Every call and follow-up due today is done."
          action={
            <Button asChild variant="outline">
              <Link to="/tasks">Back to Tasks</Link>
            </Button>
          }
        />
      );
  else
    body = (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="space-y-4 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="type-small text-muted-foreground" aria-live="polite">
              {position} of {total}
            </p>
            <p className="type-small">
              {task.title} · due <RelativeTime value={task.dueAt} />
            </p>
          </div>
          <ContactFacts task={task} />
          <div className="space-y-2">
            <Label htmlFor="call-note">Note (optional)</Label>
            <Textarea
              id="call-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {callbackOpen && (
            <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
              <div className="space-y-1">
                <Label htmlFor="callback-at">Call back at</Label>
                <Input
                  id="callback-at"
                  type="datetime-local"
                  value={callbackAt}
                  onChange={(e) => setCallbackAt(e.target.value)}
                />
              </div>
              <Button onClick={saveCallback} disabled={!callbackAt}>
                Save call back
              </Button>
              <Button variant="ghost" onClick={() => setCallbackOpen(false)}>
                Cancel
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Call outcome">
            {OUTCOMES.map((o) => (
              <Button
                key={o.id}
                variant={o.id === "connected" ? "default" : "outline"}
                onClick={() => choose(o.id)}
                aria-keyshortcuts={o.key}
              >
                {o.label}
                <kbd className="ml-1 rounded border px-1 font-mono text-xs opacity-70">{o.key}</kbd>
              </Button>
            ))}
            <Button variant="ghost" onClick={skip} aria-keyshortcuts="s">
              <SkipForward /> Skip
            </Button>
          </div>
        </Card>
        <aside className="space-y-3" aria-label="Last activity">
          <h2 className="type-label text-muted-foreground">Last 3 activities</h2>
          <ActivityFeed key={task.contact.id} contactId={task.contact.id} limit={3} />
          {next && (
            <p className="type-small text-muted-foreground">
              Next: {next.contact.name} — {next.title}
            </p>
          )}
        </aside>
      </div>
    );

  return (
    <div className="pb-24">
      {header}
      <div className="px-4 pt-4 sm:px-6">{body}</div>
      {connected && (
        <LogCallFlow
          key={connected.task.id}
          leadId={connected.task.contact.id}
          taskId={connected.task.id}
          open={connected.open}
          onOpenChange={(open) => {
            setConnected({ ...connected, open });
            if (!open) reset();
          }}
        />
      )}
      {enroll && (
        <EnrollWorkflowDialog
          leadId={enroll.leadId}
          open
          triggerFilter={enroll.trigger}
          onOpenChange={(open) => !open && setEnroll(null)}
        />
      )}
    </div>
  );
}

function ContactFacts({ task }: { task: TaskListItem }) {
  const query = useContact(task.contact.id);
  const c = query.data;
  if (!c) return query.isLoading ? <SectionSkeleton /> : <ErrorBlock error={query.error} />;
  const name = `${c.firstName} ${c.lastName}`.trim() || "Unnamed contact";
  const openDeal = c.deals.find((d) => d.stage !== "won" && d.stage !== "lost");
  return (
    <div className="space-y-2">
      <div>
        <h2 className="type-section-title">
          <Link to="/contacts/$contactId" params={{ contactId: c.id }} className="hover:underline">
            {name}
          </Link>
        </h2>
        <p className="type-body text-muted-foreground">{c.company?.name ?? c.companyText}</p>
      </div>
      {c.phone ? (
        <Button asChild size="lg">
          <a href={`tel:${c.phone}`}>
            <Phone /> {c.phone}
          </a>
        </Button>
      ) : (
        <p className="type-body text-muted-foreground">No phone number.</p>
      )}
      <PropertyList
        items={[
          { id: "enquiry", label: "Enquiry", value: c.serviceInterest || "–" },
          {
            id: "hot",
            label: "Why hot",
            value: (
              <span className="space-y-1">
                <HotScorePill score={c.hotScore} band={c.hotBand} reasons={c.hotReasons} />
                {(c.hotReasons ?? []).length > 0 && (
                  <span className="block type-small text-muted-foreground">
                    {(c.hotReasons ?? []).map(hotReasonText).join(" · ")}
                  </span>
                )}
              </span>
            ),
          },
          { id: "ai", label: "AI status", value: AGENT_STATUS_LABEL[c.agentStatus] },
          { id: "deal", label: "Open deal", value: openDeal?.name ?? "None" },
        ]}
      />
    </div>
  );
}
