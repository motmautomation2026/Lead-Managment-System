import type { Queryable } from "../dto.js";
import { onAgentEvent } from "./agentEvents.service.js";
import type { Actor } from "../authMiddleware.js";
import { DoNotContactError, NotFoundError, ValidationError } from "../errors.js";
import type { CallConnectedOutcome, CallNotConnectedReason, LeadLossReason } from "../domain/enums.js";
import { routeConnectedOutcome, routeNotConnected, type InterestedLaterCapture } from "../domain/callRouting.js";
import { addTimelineEvent, actorEvent } from "./timeline.service.js";
import { createTask, cancelOpenTasksForLead, completeTask } from "./tasks.service.js";
import { getLeadRowOr404, markDnc, markLost, moveToLongTermNurture, setAutomationMode, setContactability, updateLead } from "./leads.service.js";
import { addDaysIso } from "../dto.js";
import { callAttemptTitle, FIX_PHONE_TITLE, isBadNumber, nextAttemptDueAt, nextAttemptNumber } from "../domain/callAttempts.js";
import { coveredByAi, coveredByWorkflow, DECIDE_NEXT_STEP_TITLE } from "../domain/nextAction.js";
import { istDate } from "../domain/workingTime.js";
import type { LossDetails } from "../domain/recovery.js";
import { createResponsibleTask, factsOf, LEAD_FACTS_SQL, type FactsRow } from "./nextAction.service.js";
import { autoEnroll } from "./runs.service.js";
import { enqueueTriedCalling } from "./triedCalling.service.js";
import { isLeadAutomated } from "./leadAutomation.service.js";

export interface LogCallInput {
  connected: boolean;
  notConnectedReason?: CallNotConnectedReason;
  connectedOutcome?: CallConnectedOutcome;
  notes?: string;
  /** Required when connectedOutcome === 'callback_requested'. */
  callbackDueAt?: string;
  /** When set, the open 'call' task that prompted this log is completed atomically with it. */
  taskId?: string;
  /** "Interested - Later" capture — read only when connectedOutcome === 'interested_later' (LL-3: restartAt required). */
  interestedLater?: InterestedLaterCapture;
  /** LL-3 rule 4: required when connectedOutcome === 'not_interested'. */
  notInterested?: { lossReason: LeadLossReason } & LossDetails;
}

export interface CallRow {
  id: string;
  lead_id: string;
  salesperson_id: string | null;
  salesperson_name: string;
  connected: boolean;
  not_connected_reason: CallNotConnectedReason | null;
  connected_outcome: CallConnectedOutcome | null;
  notes: string | null;
  callback_due_at: Date | null;
  attempt_number: number | null;
  created_at: Date;
}

function callToDto(row: CallRow) {
  return {
    id: row.id,
    leadId: row.lead_id,
    salespersonId: row.salesperson_id ?? undefined,
    salespersonName: row.salesperson_name,
    connected: row.connected,
    notConnectedReason: row.not_connected_reason ?? undefined,
    connectedOutcome: row.connected_outcome ?? undefined,
    notes: row.notes ?? undefined,
    callbackDueAt: row.callback_due_at?.toISOString(),
    attemptNumber: row.attempt_number ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Logs a call and processes its full business outcome as one operation
 * (product brief, "CALL PROCESS": "the backend should process the business
 * outcome, not merely save a call record"). Runs inside a single caller-
 * supplied transaction (see routes/calls.routes.ts) so the call record,
 * lead state, task, and workflow enrollment either all land or none do
 * (Rule 16).
 */
export async function logCall(db: Queryable, actor: Actor, workspaceId: string, leadId: string, input: LogCallInput) {
  const lead = await getLeadRowOr404(db, workspaceId, leadId);
  if (lead.lifecycle_state === "do_not_contact") {
    throw new DoNotContactError("This lead is Do Not Contact - no further contact can be logged.");
  }

  if (input.connected && !input.connectedOutcome) {
    throw new ValidationError("connectedOutcome is required when the call connected.");
  }
  if (!input.connected && !input.notConnectedReason) {
    throw new ValidationError("notConnectedReason is required when the call did not connect.");
  }
  if (input.connectedOutcome === "callback_requested" && !input.callbackDueAt) {
    throw new ValidationError("callbackDueAt is required for a Callback Requested outcome.");
  }
  if (input.callbackDueAt && Date.parse(input.callbackDueAt) <= Date.now()) {
    throw new ValidationError("callbackDueAt must be in the future.");
  }
  // LL-3 rule 5: the restart date is required (and in the future).
  const restartAt = input.interestedLater?.restartAt?.slice(0, 10);
  if (input.connected && input.connectedOutcome === "interested_later" && (!restartAt || !/^\d{4}-\d{2}-\d{2}$/.test(restartAt) || restartAt <= istDate(new Date()))) {
    throw new ValidationError("A future restart date is required for Interested later.");
  }
  if (input.connected && input.connectedOutcome === "not_interested" && !input.notInterested?.lossReason) {
    throw new ValidationError("A reason is required for Not interested.");
  }
  const unanswered = !input.connected && !isBadNumber(input.notConnectedReason!);
  const attemptNumber = unanswered ? await currentAttemptNumber(db, leadId) : null;

  const callResult = await db.query<CallRow>(
    `insert into public.calls
      (workspace_id, lead_id, salesperson_id, salesperson_name, connected, not_connected_reason, connected_outcome, notes, callback_due_at, attempt_number)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning *`,
    [
      workspaceId,
      leadId,
      actor.id,
      actor.fullName,
      input.connected,
      input.connected ? null : input.notConnectedReason,
      input.connected ? input.connectedOutcome : null,
      input.notes?.trim() || null,
      input.connectedOutcome === "callback_requested" ? input.callbackDueAt : null,
      attemptNumber,
    ],
  );
  const call = callResult.rows[0]!;

  await addTimelineEvent(db, {
    leadId,
    kind: "call",
    title: input.connected ? `Call Connected - ${input.connectedOutcome}` : attemptNumber ? `Call Not Connected (attempt ${attemptNumber})` : "Call Not Connected",
    detail: input.connected ? input.notes : `${input.notConnectedReason}${input.notes ? ` - ${input.notes}` : ""}`,
    ...actorEvent(actor),
    relatedCallId: call.id,
  });

  if (input.taskId) {
    const taskResult = await db.query<{ id: string; lead_id: string; task_type: string; status: string }>(
      `select id, lead_id, task_type, status from public.tasks where id = $1 and workspace_id = $2`,
      [input.taskId, workspaceId],
    );
    const task = taskResult.rows[0];
    if (!task) throw new NotFoundError("Task");
    if (task.lead_id !== leadId) throw new ValidationError("Task does not belong to this lead.");
    // UX-2: the call queue also works follow-up tasks (a call is how a rep follows up).
    if (task.task_type !== "call" && task.task_type !== "follow_up") {
      throw new ValidationError("Only a call or follow-up task can be completed by logging a call.");
    }
    if (task.status !== "open") throw new ValidationError("This task is no longer open.");
    await completeTask(db, actor, workspaceId, input.taskId);
  }

  // Do Not Contact overrides everything else — shares the same path as the
  // lead-level DNC endpoint (Rule 6).
  if (input.connected && input.connectedOutcome === "do_not_contact") {
    await markDnc(db, actor, workspaceId, leadId, { reason: input.notes?.trim() || "Requested on call" });
    return { call: callToDto(call), lead: await getLeadRowOr404(db, workspaceId, leadId), workflowTrigger: undefined, promptScheduleMeeting: false };
  }

  // LL-3 rule 4: Not interested → Lost with that reason through the existing Lost path (open tasks closed, AI
  // stopped by the lifecycle trigger, deals closed, recovery date set by reason).
  if (input.connected && input.connectedOutcome === "not_interested") {
    const { lossReason, ...details } = input.notInterested!;
    await markLost(db, actor, workspaceId, leadId, lossReason, input.notes, details);
    return { call: callToDto(call), lead: await getLeadRowOr404(db, workspaceId, leadId), workflowTrigger: undefined, promptScheduleMeeting: false };
  }

  const routing = input.connected
    ? routeConnectedOutcome(
        input.connectedOutcome as Exclude<CallConnectedOutcome, "do_not_contact" | "not_interested">,
        input.interestedLater,
      )
    : routeNotConnected(input.notConnectedReason!);

  if (routing.phoneContactStatus) {
    await setContactability(db, actor, workspaceId, leadId, { channel: "phone", status: routing.phoneContactStatus, reason: `Call outcome: ${input.notConnectedReason}` });
  }

  // stage and objectionType (and, for interested_later, the capture fields)
  // must land in ONE update statement: leads_objection_stage_has_type
  // requires objection_type whenever pipeline_stage = 'objection_nurture',
  // and that constraint is checked against the row as written, not per-column.
  if (routing.stage || routing.objectionType) {
    await updateLead(db, actor, workspaceId, leadId, {
      ...(routing.stage ? { pipelineStage: routing.stage } : {}),
      ...(routing.objectionType ? { objectionType: routing.objectionType } : {}),
      ...(input.connectedOutcome === "interested_later" && input.interestedLater
        ? {
            interestedLaterReason: input.interestedLater.reason,
            interestedLaterRestartAt: input.interestedLater.restartAt,
            interestedLaterNextAction: input.interestedLater.nextAction,
            interestedLaterDecisionOwner: input.interestedLater.decisionOwner,
          }
        : {}),
    });
  }
  if (routing.automation) {
    await setAutomationMode(db, actor, workspaceId, leadId, routing.automation, `Call outcome: ${input.connected ? input.connectedOutcome : "Not Connected"}`);
  }

  // LL-3 rule 2: a connected call ends the ladder (the counter resets by itself: attempt_number is per unanswered call).
  if (input.connected) {
    await cancelOpenTasksForLead(db, actor, leadId, "The lead answered a call", undefined, { markers: ["call_attempt"] });
  }

  if (routing.task) {
    const dueAt =
      input.connectedOutcome === "callback_requested" && input.callbackDueAt
        ? input.callbackDueAt
        : (routing.task.dueAt?.toISOString() ?? addDaysIso(routing.task.dueInDays ?? 1));
    if (input.connectedOutcome === "interested_later") {
      await createResponsibleTask(db, workspaceId, leadId, { type: routing.task.type, title: routing.task.title, dueAt: new Date(dueAt), marker: "interested_later_callback" });
    } else {
      await createTask(db, actor, workspaceId, {
        leadId,
        ownerId: lead.owner_id,
        type: routing.task.type,
        title: routing.task.title,
        dueAt,
        origin: "manual",
      });
    }
  }

  // A fresh reply/outcome makes stale "meeting CTA" nurture obsolete —
  // clear any still-open Send Proposal/Schedule Meeting acquisition tasks
  // that would now conflict with the new next action created above, EXCEPT
  // the one we just created. Positive outcomes move a lead out of nurture
  // entirely, so any leftover nurture follow-up task is now stale.
  if (input.connected && input.connectedOutcome === "positive") {
    await cancelOpenTasksForLead(db, actor, leadId, "Superseded by positive call outcome", ["follow_up", "nurture"]);
  }

  // LL-3 rule 8: call-outcome workflows start by themselves — this only creates the enrollment (run + first scheduled
  // step); the worker runs it. Meeting Agreed stays schedule-first: the UI enrolls after the meeting is booked
  // (booking cancels active runs), so only that trigger still goes back to the client.
  if (routing.workflowTrigger && routing.workflowTrigger !== "meeting_agreed") {
    await autoEnroll(db, workspaceId, leadId, routing.workflowTrigger, `Call outcome: ${input.connected ? input.connectedOutcome : input.notConnectedReason}`);
  }

  // REL-1: the retry ladder, "Fix the phone number" and "We tried calling" only for automated leads.
  if (!input.connected && (await isLeadAutomated(db, leadId))) {
    if (attemptNumber) await afterUnansweredCall(db, actor, workspaceId, leadId, call, attemptNumber);
    else await afterBadNumber(db, actor, workspaceId, leadId);
  }

  await onAgentEvent(db, { workspaceId, leadId, event: "call_logged", payload: { callId: call.id } });
  return {
    call: callToDto(call),
    lead: await getLeadRowOr404(db, workspaceId, leadId),
    workflowTrigger: routing.workflowTrigger === "meeting_agreed" ? routing.workflowTrigger : undefined,
    promptScheduleMeeting: routing.promptScheduleMeeting,
  };
}

/**
 * Rule 2: the previous call's attempt number, and whether the lead replied / booked a meeting since it (a reset).
 * A connected or wrong-number call has no attempt number, so the next unanswered call starts again at 1.
 */
export const PREVIOUS_ATTEMPT_SQL = `select c.attempt_number,
       (exists (select 1 from public.whatsapp_inbound_events i where i.lead_id = c.lead_id and i.received_at > c.created_at)
        or exists (select 1 from public.email_inbound_events e where e.lead_id = c.lead_id and e.match_status = 'matched'
                    and e.kind in ('reply', 'unsubscribe') and e.received_at > c.created_at)
        or exists (select 1 from public.meetings m where m.lead_id = c.lead_id and m.created_at > c.created_at)) as reset_since
  from public.calls c where c.lead_id = $1 order by c.created_at desc, c.id desc limit 1`;

async function currentAttemptNumber(db: Queryable, leadId: string): Promise<number> {
  const prev = (await db.query<{ attempt_number: number | null; reset_since: boolean }>(PREVIOUS_ATTEMPT_SQL, [leadId])).rows[0];
  return nextAttemptNumber(prev ? { attemptNumber: prev.attempt_number } : null, prev?.reset_since ?? false);
}

/**
 * Rules 2 + 3 after unanswered call N: the open call tasks close, "Call attempt N+1" (ladder time) for the responsible
 * person, the "We tried calling" WhatsApp queued. After the 5th: no more call tasks — if the AI or a workflow still
 * covers the lead it stops there, else long-term nurture + "Decide the next step" (LL-1).
 */
async function afterUnansweredCall(db: Queryable, actor: Actor, workspaceId: string, leadId: string, call: CallRow, attempt: number) {
  await cancelOpenTasksForLead(db, actor, leadId, `Call attempt ${attempt} not answered`, ["call"]);
  const due = nextAttemptDueAt(attempt, call.created_at);
  if (due) {
    await createResponsibleTask(db, workspaceId, leadId, { type: "call", title: callAttemptTitle(attempt + 1), dueAt: due, marker: "call_attempt", callAttempt: attempt + 1 });
  } else {
    const facts = (await db.query<FactsRow>(LEAD_FACTS_SQL, [leadId, new Date()])).rows[0];
    const covered = facts ? coveredByWorkflow(factsOf(facts)) || coveredByAi(factsOf(facts)) : false;
    if (!covered) {
      const current = await getLeadRowOr404(db, workspaceId, leadId);
      if (current.lifecycle_state === "active") await moveToLongTermNurture(db, actor, workspaceId, leadId, `${attempt} calls not answered`);
      const name = [current.first_name, current.last_name].filter(Boolean).join(" ").trim() || "A contact";
      await createResponsibleTask(
        db,
        workspaceId,
        leadId,
        { type: "follow_up", title: DECIDE_NEXT_STEP_TITLE, dueAt: new Date(), marker: "call_ladder_end" },
        { title: `${name}: ${attempt} calls not answered — decide the next step`.slice(0, 300), kind: "warning" },
      );
    }
  }
  await enqueueTriedCalling(db, workspaceId, leadId, call.id, actor.fullName);
}

/** Rule 2: a wrong / invalid number stops the ladder: the open call tasks close and "Fix the phone number" is due now. */
async function afterBadNumber(db: Queryable, actor: Actor, workspaceId: string, leadId: string) {
  await cancelOpenTasksForLead(db, actor, leadId, "Wrong phone number", ["call"]);
  await createResponsibleTask(db, workspaceId, leadId, { type: "general_task", title: FIX_PHONE_TITLE, dueAt: new Date(), marker: "fix_phone" });
}

export async function listCallsForLead(db: Queryable, workspaceId: string, leadId: string) {
  const result = await db.query<CallRow>(
    `select * from public.calls where workspace_id = $1 and lead_id = $2 order by created_at desc`,
    [workspaceId, leadId],
  );
  return result.rows.map(callToDto);
}
