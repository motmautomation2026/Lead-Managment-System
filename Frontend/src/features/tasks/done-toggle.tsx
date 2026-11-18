import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskListItem } from "@/types";

/** The Done toggle: a round checkbox-like button (open → done); completed shows a tick. */
export function DoneToggle({
  task,
  onDone,
}: {
  task: TaskListItem;
  onDone: (t: TaskListItem) => void;
}) {
  const done = task.status === "completed";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? `${task.title} is done` : `Mark ${task.title} done`}
      disabled={task.status !== "open"}
      onClick={(e) => {
        e.stopPropagation();
        onDone(task);
      }}
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full border transition-colors",
        done
          ? "border-success bg-success text-success-foreground"
          : "border-input hover:border-primary disabled:opacity-50",
      )}
    >
      {done && <Check className="size-3.5" />}
    </button>
  );
}
