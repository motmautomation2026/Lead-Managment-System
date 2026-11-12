import { dayEnd } from "@/features/contacts/contacts-search";
import { dateInputValue } from "@/lib/dates";
import type { TaskListParams } from "@/types";

/** How long Undo is offered; the call is only sent to the backend after it. */
export const UNDO_MS = 6000;

/** My open call / follow-up tasks due today or overdue, hottest contacts first (UX-2 rule 5). */
export function callQueueParams(): TaskListParams {
  return {
    ownerId: ["me"],
    type: ["call", "follow_up"],
    dueTo: dayEnd(dateInputValue(0)),
    replyTasks: "exclude",
    sort: "hotScore:desc",
    limit: 25,
  };
}
