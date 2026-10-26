/**
 * GET /home/summary (C6b): the Home page for the signed-in user. Built from the list
 * services so every count matches the list it links to (same filters, IST days in SQL).
 * B38: today's meetings exclude cancelled / no-show / failed (and completed) meetings.
 */
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { DEAL_STAGES } from "../domain/enums.js";
import { countWorkMeetings, countWorkProposals, countWorkTasks, listWorkMeetings, listWorkTasks, meetingListSchema, taskListSchema } from "./workLists.service.js";
import { dealBoard, dealBoardSchema } from "./dealRecords.service.js";

/** Meetings that are still going to happen today (the Meetings page "Today" view adds these statuses). */
export const HOME_MEETING_STATUSES = ["scheduled", "confirmed", "rescheduled"] as const;
const OPEN_STAGES: readonly string[] = DEAL_STAGES.filter((s) => s !== "won" && s !== "lost");

export async function getHomeSummary(db: Queryable, actor: Actor, workspaceId: string) {
  const mine = { ownerId: ["me"] };
  const todayMeetings = { ...mine, when: "today" as const, status: [...HOME_MEETING_STATUSES] };
  const [overdue, dueToday, nextTasks, meetingsToday, meetingsTodayCount, needsOutcome, board, awaiting, agent] = await Promise.all([
    countWorkTasks(db, actor, workspaceId, { ...mine, due: "overdue" }),
    countWorkTasks(db, actor, workspaceId, { ...mine, due: "today" }),
    listWorkTasks(db, actor, workspaceId, taskListSchema.parse({ ...mine, limit: 5 })),
    listWorkMeetings(db, actor, workspaceId, meetingListSchema.parse({ ...todayMeetings, limit: 10 })),
    countWorkMeetings(db, actor, workspaceId, todayMeetings),
    countWorkMeetings(db, actor, workspaceId, { ...mine, when: "needs_outcome" }),
    dealBoard(db, actor, workspaceId, dealBoardSchema.parse(mine)),
    countWorkProposals(db, actor, workspaceId, { ...mine, group: "awaiting_decision" }),
    db.query<{ mode: string | null; drafts: number }>(
      `select (select mode from public.agent_settings where workspace_id = $1) as mode,
              (select count(*)::int from public.agent_decisions where workspace_id = $1 and outcome = 'draft' and rating is null) as drafts`,
      [workspaceId],
    ),
  ]);
  const stages = board.data.filter((col) => OPEN_STAGES.includes(col.stage)).map(({ stage, count, amountTotal }) => ({ stage, count, amountTotal }));
  const ai = agent.rows[0]!;
  return {
    tasks: { overdue: overdue.count, dueToday: dueToday.count, next: nextTasks.data },
    meetings: { today: meetingsToday.data, todayCount: meetingsTodayCount.count, needsOutcome: needsOutcome.count },
    deals: {
      openCount: stages.reduce((sum, s) => sum + s.count, 0),
      openAmount: stages.reduce((sum, s) => sum + s.amountTotal, 0),
      stages,
    },
    proposals: { awaitingDecision: awaiting.count },
    // Unrated drafts in the workspace (the AI Activity list is workspace-wide); null while the agent is off.
    ai: ai.mode && ai.mode !== "off" ? { mode: ai.mode, draftsToReview: ai.drafts } : null,
  };
}
