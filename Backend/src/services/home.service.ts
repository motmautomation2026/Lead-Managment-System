/**
 * GET /home/summary (C6b, UX-3 "My day"): the Home page for the signed-in user. Built from the list
 * services so every count matches the list it links to (same filters, IST days in SQL).
 * B38: today's meetings exclude cancelled / no-show / failed (and completed) meetings.
 * UX-3: replies waiting (Replies queue), calls due today / overdue (call queue), "Decide the next step" tasks
 * (LL-1), overdue tasks — each a count + the top 5; admins also get a team row and this workspace's red flags.
 */
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { DEAL_STAGES } from "../domain/enums.js";
import { DECIDE_NEXT_STEP_TITLE } from "../domain/nextAction.js";
import { REPLY_TASK_TITLES } from "../agent/replyClassification.js";
import { countWorkMeetings, countWorkProposals, countWorkTasks, listWorkMeetings, listWorkTasks, meetingListSchema, taskListSchema } from "./workLists.service.js";
import { dealBoard, dealBoardSchema } from "./dealRecords.service.js";
import { RED_PROBLEM_TEXT, workspaceHealth } from "./systemHealth.service.js";

/** Meetings that are still going to happen today (the Meetings page "Today" view adds these statuses). */
export const HOME_MEETING_STATUSES = ["scheduled", "confirmed", "rescheduled"] as const;
const OPEN_STAGES: readonly string[] = DEAL_STAGES.filter((s) => s !== "won" && s !== "lost");
const TOP = 5;
// shortcut: the team row lists at most 50 members (busiest first); a bigger team needs a paged endpoint.
const TEAM_LIMIT = 50;

/** The last millisecond of `now`'s IST day, as the call queue's `dueTo` (due today or overdue). */
export function istDayEndIso(now: Date): string {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) - 330 * 60_000 - 1).toISOString();
}

/** Per active member: open tasks, overdue, replies waiting (the Replies queue's tasks). $1 workspace, $2 reply titles, $3 limit. */
export const TEAM_ROW_SQL = `select m.user_id as id, p.full_name as name,
       count(t.id)::int as open_tasks,
       count(t.id) filter (where t.due_at < now())::int as overdue,
       count(t.id) filter (where t.origin = 'agent' and t.title = any($2::text[]))::int as replies
  from public.workspace_members m
  join public.profiles p on p.id = m.user_id and p.is_active
  left join public.tasks t on t.owner_id = m.user_id and t.workspace_id = m.workspace_id and t.status = 'open'
 where m.workspace_id = $1
 group by m.user_id, p.full_name
 order by overdue desc, open_tasks desc, p.full_name
 limit $3`;

/** LL-2: the "no mailbox" warning was raised and the workspace still has no SMTP mailbox sending. $1 workspace. */
export const NO_MAILBOX_SQL = `select exists (select 1 from public.system_health_alerts where workspace_id = $1 and problem = 'staff_email_no_mailbox')
   and not exists (select 1 from public.integration_connections c where c.workspace_id = $1 and c.id = 'email' and c.provider = 'smtp' and c.enabled) as warn`;
const NO_MAILBOX_TEXT = "Staff email alerts are off: no email mailbox is connected (or sending is paused).";

export async function getHomeSummary(db: Queryable, actor: Actor, workspaceId: string) {
  const mine = { ownerId: ["me"] };
  const todayMeetings = { ...mine, when: "today" as const, status: [...HOME_MEETING_STATUSES] };
  const replies = { ...mine, replyTasks: "only" as const };
  const calls = { ...mine, type: ["call" as const, "follow_up" as const], dueTo: istDayEndIso(new Date()), replyTasks: "exclude" as const };
  const decide = { ...mine, q: DECIDE_NEXT_STEP_TITLE };
  const overdueTasks = { ...mine, due: "overdue" as const };
  const top = (filters: Record<string, unknown>, sort: string) => listWorkTasks(db, actor, workspaceId, taskListSchema.parse({ ...filters, sort, limit: TOP }));
  const admin = actor.role === "admin";

  const [
    overdue,
    dueToday,
    nextTasks,
    meetingsToday,
    meetingsTodayCount,
    needsOutcome,
    board,
    awaiting,
    agent,
    replyCount,
    replyTop,
    callCount,
    callTop,
    decideCount,
    decideTop,
    overdueTop,
    team,
    health,
    mailbox,
  ] = await Promise.all([
    countWorkTasks(db, actor, workspaceId, overdueTasks),
    countWorkTasks(db, actor, workspaceId, { ...mine, due: "today" }),
    listWorkTasks(db, actor, workspaceId, taskListSchema.parse({ ...mine, limit: TOP })),
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
    countWorkTasks(db, actor, workspaceId, replies),
    top(replies, "createdAt:asc"),
    countWorkTasks(db, actor, workspaceId, calls),
    top(calls, "hotScore:desc"),
    countWorkTasks(db, actor, workspaceId, decide),
    top(decide, "dueAt:asc"),
    top(overdueTasks, "dueAt:asc"),
    admin ? db.query<{ id: string; name: string; open_tasks: number; overdue: number; replies: number }>(TEAM_ROW_SQL, [workspaceId, REPLY_TASK_TITLES, TEAM_LIMIT]) : null,
    admin ? workspaceHealth(db, [workspaceId]) : null,
    admin ? db.query<{ warn: boolean }>(NO_MAILBOX_SQL, [workspaceId]) : null,
  ]);
  const stages = board.data.filter((col) => OPEN_STAGES.includes(col.stage)).map(({ stage, count, amountTotal }) => ({ stage, count, amountTotal }));
  const ai = agent.rows[0]!;
  const flags = [
    ...(health?.[0]?.red ?? []).map((code) => ({ code: code as string, text: RED_PROBLEM_TEXT[code] })),
    ...(mailbox?.rows[0]?.warn ? [{ code: "staff_email_no_mailbox", text: NO_MAILBOX_TEXT }] : []),
  ];
  return {
    tasks: { overdue: overdue.count, dueToday: dueToday.count, next: nextTasks.data, overdueTop: overdueTop.data },
    meetings: { today: meetingsToday.data, todayCount: meetingsTodayCount.count, needsOutcome: needsOutcome.count },
    replies: { count: replyCount.count, top: replyTop.data },
    calls: { count: callCount.count, top: callTop.data },
    nextSteps: { count: decideCount.count, top: decideTop.data },
    deals: {
      openCount: stages.reduce((sum, s) => sum + s.count, 0),
      openAmount: stages.reduce((sum, s) => sum + s.amountTotal, 0),
      stages,
    },
    proposals: { awaitingDecision: awaiting.count },
    // Unrated drafts in the workspace (the AI Activity list is workspace-wide); null while the agent is off.
    ai: ai.mode && ai.mode !== "off" ? { mode: ai.mode, draftsToReview: ai.drafts } : null,
    // Admins only (null for salespeople): per-rep work and this workspace's red flags from System health.
    team: team ? team.rows.map((r) => ({ id: r.id, name: r.name, openTasks: r.open_tasks, overdue: r.overdue, replies: r.replies })) : null,
    flags: admin ? flags : null,
  };
}
