import { toast } from "sonner";

/**
 * The toast + Undo pattern for reversible actions: do the action at once, then offer Undo for a few
 * seconds. `undo` runs the reverse call; its own errors are the caller's to toast.
 */
export function toastUndo(message: string, undo: () => void, durationMs = 6000) {
  return toast.success(message, {
    duration: durationMs,
    action: { label: "Undo", onClick: undo },
  });
}
