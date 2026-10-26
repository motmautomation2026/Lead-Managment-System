import { label } from "@/lib/labels";
import type { RunAction } from "@/store";
import type { RunListItem } from "@/types";

/** What a run's current step reads as (same wording as the old Runs page). */
export function currentStepText(run: RunListItem) {
  if (run.currentStepAction) return label(run.currentStepAction);
  return ["running", "waiting"].includes(run.status) ? "No enabled steps configured" : "-";
}

/** The actions today's Runs page offered per status. */
export function runActions(status: RunListItem["status"]): { action: RunAction; text: string }[] {
  return [
    ...(status === "failed" ? [{ action: "retry" as const, text: "Retry" }] : []),
    ...(status === "running" || status === "waiting"
      ? [{ action: "pause" as const, text: "Pause" }]
      : []),
    ...(status === "paused" ? [{ action: "resume" as const, text: "Resume" }] : []),
    ...(["running", "waiting", "paused", "failed"].includes(status)
      ? [{ action: "cancel" as const, text: "Cancel" }]
      : []),
  ];
}
