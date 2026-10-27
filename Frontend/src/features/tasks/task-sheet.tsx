import { useState } from "react";
import { toast } from "sonner";
import { Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PropertyList } from "@/components/crm/property-list";
import { RelativeTime } from "@/components/crm/relative-time";
import { StatusPill } from "@/components/crm/status-pill";
import { TaskOriginBadge } from "@/components/common/status-badge";
import { ReadReplyLink } from "@/features/crm/activity-feed";
import { REPLY_TASK_TITLES } from "@/features/agent/agent-labels";
import { RefLink } from "@/features/work/ref-link";
import { istParts, toIsoFromIst } from "@/lib/dates";
import { label } from "@/lib/labels";
import { messageFromError, useCancelTask, useSession, useUpdateTask } from "@/store";
import type { TaskListItem } from "@/types";
import { TASK_STATUS_TONE } from "./task-columns";

type Panel = "reschedule" | "reassign" | "cancel" | null;

/**
 * A task's row Sheet: details and its actions. Complete and Log call go back to the page
 * (the Done toggle's rules and the one LogCallFlow); the rest are PATCH / cancel here.
 */
export function TaskSheet({
  task,
  onOpenChange,
  onComplete,
  onLogCall,
}: {
  task: TaskListItem | null;
  onOpenChange: (open: boolean) => void;
  onComplete: (task: TaskListItem) => void;
  onLogCall: (task: TaskListItem) => void;
}) {
  return (
    <Sheet open={Boolean(task)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        {task && (
          <TaskDetails
            key={task.id}
            task={task}
            onComplete={onComplete}
            onLogCall={onLogCall}
            onDone={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function TaskDetails({
  task,
  onComplete,
  onLogCall,
  onDone,
}: {
  task: TaskListItem;
  onComplete: (task: TaskListItem) => void;
  onLogCall: (task: TaskListItem) => void;
  onDone: () => void;
}) {
  const { users } = useSession();
  const update = useUpdateTask();
  const cancel = useCancelTask();
  const [panel, setPanel] = useState<Panel>(null);
  const [due, setDue] = useState(() => istParts(task.dueAt));
  const [ownerId, setOwnerId] = useState(task.ownerId ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const open = task.status === "open";

  const run = async (work: () => Promise<unknown>, success: string) => {
    setError(null);
    try {
      await work();
      toast.success(success);
      onDone();
    } catch (e) {
      setError(messageFromError(e));
    }
  };

  return (
    <>
      <SheetHeader className="border-b">
        <SheetTitle className="pr-6">{task.title}</SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-2">
          <StatusPill tone={TASK_STATUS_TONE[task.status]}>{label(task.status)}</StatusPill>
          <TaskOriginBadge origin={task.origin} />
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-4 p-4">
        <PropertyList
          items={[
            { id: "type", label: "Type", value: label(task.type) },
            {
              id: "due",
              label: "Due",
              value: (
                <RelativeTime
                  value={task.dueAt}
                  className={task.isOverdue ? "text-destructive" : ""}
                />
              ),
            },
            { id: "owner", label: "Owner", value: task.ownerName ?? "No owner" },
            {
              id: "contact",
              label: "Contact",
              value: <RefLink type="contact" value={task.contact} />,
            },
            {
              id: "company",
              label: "Company",
              value: <RefLink type="company" value={task.company} />,
            },
            ...(task.cancelReason
              ? [{ id: "reason", label: "Cancel reason", value: task.cancelReason }]
              : []),
          ]}
        />
        {task.origin === "agent" && REPLY_TASK_TITLES.includes(task.title) && (
          <ReadReplyLink contactId={task.contact.id} />
        )}
        {open && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onComplete(task)}>
              Complete
            </Button>
            <Button size="sm" variant="outline" onClick={() => onLogCall(task)}>
              <Phone /> Log call
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPanel("reschedule")}>
              Reschedule
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPanel("reassign")}>
              Reassign
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPanel("cancel")}>
              Cancel task
            </Button>
          </div>
        )}
        {panel === "reschedule" && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="task-due-date" className="mb-1.5 block text-xs">
                  New date
                </Label>
                <Input
                  id="task-due-date"
                  type="date"
                  value={due.date}
                  onChange={(e) => setDue((d) => ({ ...d, date: e.target.value }))}
                />
              </div>
              <div>
                <Label htmlFor="task-due-time" className="mb-1.5 block text-xs">
                  Time (IST)
                </Label>
                <Input
                  id="task-due-time"
                  type="time"
                  value={due.time}
                  onChange={(e) => setDue((d) => ({ ...d, time: e.target.value }))}
                />
              </div>
            </div>
            <Button
              size="sm"
              disabled={!due.date || !due.time || update.isPending}
              onClick={() =>
                void run(
                  () =>
                    update.mutateAsync({
                      id: task.id,
                      input: { dueAt: toIsoFromIst(due.date, `${due.time}:00`) },
                    }),
                  "Task rescheduled",
                )
              }
            >
              Save new time
            </Button>
          </div>
        )}
        {panel === "reassign" && (
          <div className="space-y-2 rounded-md border p-3">
            <Label htmlFor="task-new-owner" className="block text-xs">
              New owner
            </Label>
            <Select value={ownerId} onValueChange={setOwnerId}>
              <SelectTrigger id="task-new-owner">
                <SelectValue placeholder="Choose an owner" />
              </SelectTrigger>
              <SelectContent>
                {users
                  .filter((u) => u.active)
                  .map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={!ownerId || ownerId === task.ownerId || update.isPending}
              onClick={() =>
                void run(
                  () => update.mutateAsync({ id: task.id, input: { ownerId } }),
                  "Task reassigned",
                )
              }
            >
              Reassign
            </Button>
          </div>
        )}
        {panel === "cancel" && (
          <div className="space-y-2 rounded-md border p-3">
            <Label htmlFor="task-cancel-reason" className="block text-xs">
              Reason (optional)
            </Label>
            <Textarea
              id="task-cancel-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              size="sm"
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() =>
                void run(
                  () => cancel.mutateAsync({ id: task.id, reason: reason.trim() || undefined }),
                  "Task cancelled",
                )
              }
            >
              Cancel task
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </>
  );
}
