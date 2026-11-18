import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ArrowLeft, Check, MessageSquareReply, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/crm/page-header";
import { EmptyState } from "@/components/crm/empty-state";
import { RelativeTime } from "@/components/crm/relative-time";
import { SectionSkeleton } from "@/components/crm/section-skeleton";
import { ErrorBlock } from "@/components/common/server-state";
import { ActivityFeed } from "@/features/crm/activity-feed";
import { useCompleteTask, useTaskCount, useTaskList } from "@/store";
import { MY_REPLIES } from "./tasks-search";

const QUEUE = { ...MY_REPLIES, sort: "createdAt:asc", limit: 25 };

/**
 * UX-2 Replies queue: my open "Lead replied" tasks, oldest first, one at a time. The reply text is
 * shown only through the existing audited "Show message" (owner + admins; others see why not),
 * with the Suggested reply card (edit → Send / Discard). Send (the backend marks the reply task
 * done), Discard and Mark done move to the next reply.
 */
export function ReplyQueuePage() {
  const list = useTaskList(QUEUE);
  const count = useTaskCount(MY_REPLIES);
  const complete = useCompleteTask();
  // Handled in this visit: hidden at once (the list refetch drops done tasks; a discarded
  // draft's task stays open and comes back next time).
  const [handled, setHandled] = useState<string[]>([]);
  const [worked, setWorked] = useState(0);

  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.data) ?? [], [list.data]);
  const queue = rows.filter((t) => !handled.includes(t.id));
  const task = queue[0] ?? null;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    if (!task && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [task, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const next = () => {
    if (!task) return;
    setHandled((h) => [...h, task.id]);
    setWorked((n) => n + 1);
  };
  const markDone = () => {
    if (!task) return;
    const done = task;
    next();
    complete.mutate(done.id, {
      onSuccess: () => toast.success("Reply task done"),
      onError: (error) => {
        toast.error(error.message);
        setHandled((h) => h.filter((id) => id !== done.id));
        setWorked((n) => n - 1);
      },
    });
  };

  const waiting = Math.max((count.data?.count ?? 0) - handled.length, 0);
  let body;
  if (list.isLoading) body = <SectionSkeleton />;
  else if (list.error && rows.length === 0) body = <ErrorBlock error={list.error} />;
  else if (!task)
    body = (
      <EmptyState
        icon={MessageSquareReply}
        title="No replies waiting"
        text={
          worked
            ? `You worked through ${worked} repl${worked === 1 ? "y" : "ies"}.`
            : "Every reply is answered."
        }
        action={
          <Button asChild variant="outline">
            <Link to="/tasks">Back to Tasks</Link>
          </Button>
        }
      />
    );
  else
    body = (
      <Card className="space-y-4 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="type-section-title">
              <Link
                to="/contacts/$contactId"
                params={{ contactId: task.contact.id }}
                className="hover:underline"
              >
                {task.contact.name || "Unnamed contact"}
              </Link>
            </h2>
            <p className="type-small text-muted-foreground">
              {task.title} · <RelativeTime value={task.createdAt} />
              {task.company ? ` · ${task.company.name}` : ""}
            </p>
          </div>
          <p className="type-small text-muted-foreground" aria-live="polite">
            {worked + 1} of {worked + waiting}
          </p>
        </div>
        {/* Keyed by contact: each reply starts closed (reading it is an audited click). */}
        <ActivityFeed
          key={task.id}
          contactId={task.contact.id}
          initialFilter="messages"
          limit={3}
          onDraftDone={next}
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={markDone} disabled={complete.isPending}>
            <Check /> Mark done
          </Button>
          <Button variant="ghost" onClick={next}>
            <SkipForward /> Next
          </Button>
        </div>
      </Card>
    );

  return (
    <div className="pb-24">
      <PageHeader
        title="Replies"
        count={count.data?.count ?? null}
        description="Leads who replied to you, oldest first."
        actions={
          <Button asChild variant="outline">
            <Link to="/tasks">
              <ArrowLeft /> Tasks
            </Link>
          </Button>
        }
      />
      <div className="px-4 pt-4 sm:px-6">{body}</div>
    </div>
  );
}
