import type { LifecycleState, PipelineStage } from "../domain/enums.js";
import type { AgentAction } from "./decisionSchema.js";

/**
 * E3b-1 rule 1: where the contact is in the sales process, from code (never the model), and what
 * the next AI message is for. Pure: no I/O, `now` is passed in. validateDecision enforces
 * `allowedActions`; the prompt shows the angle and the reason.
 */

export const STAGE_KEYS = [
  "new_no_contact",
  "after_call",
  "meeting_scheduled",
  "meeting_held_no_proposal",
  "meeting_no_show",
  "proposal_sent",
  "rep_owned",
  "long_term",
] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const ANGLES = [
  "welcome",
  "insight",
  "client_experience",
  "check_in",
  "final_check",
  "call_followup",
  "meeting_recap",
  "reschedule",
  "proposal_questions",
  "proposal_timing",
] as const;
export type Angle = (typeof ANGLES)[number];
export type Channel = "email" | "whatsapp";

/** One line per angle for the system rules (the same for every contact, so it stays in the cached prefix). */
export const ANGLE_RULES: Record<Angle, string> = {
  welcome: "welcome: a short first message about what they told us, and one easy question about a short call.",
  insight: "insight: one useful, specific point for their kind of business, from the knowledge or playbook.",
  client_experience: "client_experience: one relevant client experience from the knowledge, in a sentence or two.",
  check_in: "check_in: a short, friendly check-in asking whether a short call would help.",
  final_check: "final_check: the last message: polite, asks whether to stay in touch later. No pressure.",
  call_followup: "call_followup: build on the latest call or note and confirm the next step agreed there.",
  meeting_recap: "meeting_recap: thank them for the meeting and confirm the next step, using ONLY the meeting outcome notes (no notes: just thanks and the next-step question). If the outcome or notes say the lead will decide later or consult someone, offer help with any questions instead of a call slot.",
  reschedule: "reschedule: one polite message offering to find a new time for the missed meeting. No blame.",
  proposal_questions: "proposal_questions: ask whether they have any questions on the proposal.",
  proposal_timing: "proposal_timing: ask, simply, when they expect to decide on the proposal.",
};

/** Plain words for the prompt line and AI Activity. */
export const ANGLE_LABELS: Record<Angle, string> = {
  welcome: "welcome",
  insight: "insight",
  client_experience: "client experience",
  check_in: "check-in",
  final_check: "final check",
  call_followup: "call follow-up",
  meeting_recap: "meeting recap",
  reschedule: "reschedule",
  proposal_questions: "proposal questions",
  proposal_timing: "decision timing",
};

export const STAGE_LABELS: Record<StageKey, string> = {
  new_no_contact: "New, no contact yet",
  after_call: "After a call",
  meeting_scheduled: "Meeting scheduled",
  meeting_held_no_proposal: "Meeting held, no proposal",
  meeting_no_show: "Missed meeting",
  proposal_sent: "Proposal sent",
  rep_owned: "Rep owns this stage",
  long_term: "Long-term nurture",
};

/** E3b-1 rule 5: angles that ask for a call (the booking link and the suggested days go with them). */
export const CALL_ANGLES: readonly Angle[] = ["welcome", "check_in", "reschedule", "meeting_recap", "proposal_timing", "call_followup"];

const JOURNEY: readonly Angle[] = ["welcome", "insight", "client_experience", "check_in"];
const NON_SEND: readonly AgentAction[] = ["wait", "handoff", "update_stage", "stop"];
const UPCOMING_MEETING_STATUSES = ["tentative", "scheduled", "confirmed", "rescheduled"];
const REP_OWNED_PROPOSAL_STATUSES = ["revision_requested", "revised", "withdrawn"];
const PROPOSAL_DAYS = [2, 7, 14];
const PROPOSAL_ANGLES: readonly Angle[] = ["proposal_questions", "proposal_timing", "client_experience"];
const MEETING_HELD_MAX = 2;
const LONG_TERM_GAP_DAYS = 30;
const REP_OWNED_WAIT_DAYS = 7;
const DAY_MS = 24 * 3_600_000;
const IST_OFFSET_MS = 330 * 60_000;

export interface StagePlanInput {
  now: Date;
  lifecycleState: LifecycleState;
  nurtureLongTerm: boolean;
  pipelineStage: PipelineStage;
  /** The open deal's stage; null = no open deal. */
  openDealStage: string | null;
  /** The latest call or note a rep logged. */
  lastCallOrNoteAt: Date | null;
  /** The contact's latest meeting (by scheduled time). */
  latestMeeting: { status: string; outcome: string | null; scheduledAt: Date; hasNotes: boolean } | null;
  /** Any meeting still to happen (an upcoming status, scheduled in the future). */
  hasUpcomingMeeting: boolean;
  latestProposal: { status: string; sentAt: Date | null } | null;
  /** Touches that count (real sends; in shadow also the allowed drafts), oldest first. */
  touches: { at: Date; channel: Channel }[];
  conversationExists: boolean;
  emailUsable: boolean;
  whatsappUsable: boolean;
  firstChannel: Channel;
  maxTouchesTotal: number;
  /** An earlier decision for this contact was made under rep_owned (its one handoff is used). */
  repOwnedBefore: boolean;
}

export interface StagePlan {
  stageKey: StageKey;
  /** null = no message now. */
  angle: Angle | null;
  allowedActions: AgentAction[];
  /** null = no channel usable (rules.ts rule 5 decides). */
  preferredChannel: Channel | null;
  reason: string;
  /** What a disallowed action becomes. */
  fallback: { action: "wait"; days: number } | { action: "handoff"; title: string };
}

const daysUntil = (from: Date, to: Date) => Math.max(1, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));

/** The journey angle for the n-th touch (0-based): final_check is always the last allowed one, then nothing. */
export function journeyAngle(index: number, maxTotal: number, skipWelcome: boolean): Angle | null {
  if (index >= maxTotal) return null;
  if (index === maxTotal - 1) return "final_check";
  const angle = index < JOURNEY.length ? JOURNEY[index]! : (index - JOURNEY.length) % 2 === 0 ? "insight" : "client_experience";
  return angle === "welcome" && skipWelcome ? "insight" : angle;
}

/** Rule 3: alternate when both channels are usable; the first touch uses the workspace setting. */
export function preferredChannel(input: Pick<StagePlanInput, "touches" | "emailUsable" | "whatsappUsable" | "firstChannel">): Channel | null {
  if (input.emailUsable && input.whatsappUsable) {
    const last = input.touches[input.touches.length - 1];
    return last ? (last.channel === "email" ? "whatsapp" : "email") : input.firstChannel;
  }
  if (input.emailUsable) return "email";
  if (input.whatsappUsable) return "whatsapp";
  return null;
}

/** The stage plan; null when the lifecycle isn't one the agent acts on (the existing rules block it). */
export function stagePlan(input: StagePlanInput): StagePlan | null {
  const { now } = input;
  const lifecycle = input.lifecycleState;
  if (!(lifecycle === "active" || (lifecycle === "long_term_nurture" && input.nurtureLongTerm))) return null;

  const channel = preferredChannel(input);
  const sendActions: AgentAction[] = channel ? [`send_${channel}`] : ["send_email", "send_whatsapp"];
  const lastTouch = input.touches[input.touches.length - 1]?.at ?? null;
  const touchesSince = (start: Date) => input.touches.filter((t) => t.at.getTime() >= start.getTime()).length;
  const send = (stageKey: StageKey, angle: Angle, reason: string, waitDays = 7): StagePlan => ({
    stageKey,
    angle,
    allowedActions: [...sendActions, ...NON_SEND],
    preferredChannel: channel,
    reason,
    fallback: { action: "wait", days: waitDays },
  });
  const noSend = (stageKey: StageKey, reason: string, days: number): StagePlan => ({
    stageKey,
    angle: null,
    allowedActions: [...NON_SEND],
    preferredChannel: channel,
    reason,
    fallback: { action: "wait", days },
  });
  const journey = (stageKey: StageKey, reason: string): StagePlan => {
    const angle = journeyAngle(input.touches.length, input.maxTouchesTotal, input.conversationExists || stageKey !== "new_no_contact");
    return angle ? send(stageKey, angle, reason) : noSend(stageKey, "all journey messages are used", 30);
  };

  if (lifecycle === "long_term_nurture") {
    if (lastTouch && now.getTime() - lastTouch.getTime() < LONG_TERM_GAP_DAYS * DAY_MS) {
      return noSend("long_term", "long-term nurture: at most one message every 30 days", daysUntil(now, new Date(lastTouch.getTime() + LONG_TERM_GAP_DAYS * DAY_MS)));
    }
    return send("long_term", input.touches.length % 2 === 0 ? "insight" : "check_in", "long-term nurture: an occasional useful message", LONG_TERM_GAP_DAYS);
  }

  const proposal = input.latestProposal;
  if (
    (proposal && REP_OWNED_PROPOSAL_STATUSES.includes(proposal.status)) ||
    input.openDealStage === "negotiation" ||
    input.pipelineStage === "negotiation"
  ) {
    const reason = proposal && REP_OWNED_PROPOSAL_STATUSES.includes(proposal.status) ? `the proposal is ${proposal.status.replace(/_/g, " ")}` : "the deal is in negotiation";
    return {
      stageKey: "rep_owned",
      angle: null,
      // One handoff task the first time (anything else becomes it); after that only wait (or stop).
      allowedActions: input.repOwnedBefore ? ["wait", "stop"] : ["handoff", "stop"],
      preferredChannel: channel,
      reason: `${reason}: the rep owns this stage`,
      fallback: input.repOwnedBefore ? { action: "wait", days: REP_OWNED_WAIT_DAYS } : { action: "handoff", title: `Rep owns this stage: ${reason}` },
    };
  }

  const meeting = input.latestMeeting;
  const meetingPending = meeting && UPCOMING_MEETING_STATUSES.includes(meeting.status);
  if (input.hasUpcomingMeeting || meetingPending) {
    const after = meeting && meeting.scheduledAt > now ? daysUntil(now, meeting.scheduledAt) + 1 : 1;
    return noSend("meeting_scheduled", meeting && meeting.scheduledAt <= now ? "the meeting's outcome isn't recorded yet" : "a meeting is scheduled", after);
  }

  if (proposal?.status === "sent") {
    const sentAt = proposal.sentAt ?? now;
    const done = touchesSince(sentAt);
    if (done >= PROPOSAL_ANGLES.length) return noSend("proposal_sent", "3 proposal follow-ups sent: the rep owns the decision", REP_OWNED_WAIT_DAYS);
    const due = new Date(sentAt.getTime() + PROPOSAL_DAYS[done]! * DAY_MS);
    if (now < due) return noSend("proposal_sent", `proposal follow-up ${done + 1} is due ${PROPOSAL_DAYS[done]} days after sending`, daysUntil(now, due));
    const days = Math.floor((now.getTime() - sentAt.getTime()) / DAY_MS);
    return send("proposal_sent", PROPOSAL_ANGLES[done]!, `proposal sent ${days} days ago, follow-up ${done + 1} of 3`);
  }

  if (meeting?.status === "no_show") {
    if (touchesSince(meeting.scheduledAt) === 0) {
      const due = new Date(meeting.scheduledAt.getTime() + DAY_MS);
      if (now < due) return noSend("meeting_no_show", "the reschedule message goes 24 hours after the missed meeting", daysUntil(now, due));
      return send("meeting_no_show", "reschedule", "the contact missed the meeting");
    }
    return journey("meeting_no_show", "after the missed meeting, back to the usual messages");
  }

  if (meeting?.status === "completed" && meeting.outcome) {
    const done = touchesSince(meeting.scheduledAt);
    if (done >= MEETING_HELD_MAX) return noSend("meeting_held_no_proposal", "2 messages after the meeting: the rep owns the next step", REP_OWNED_WAIT_DAYS);
    const notes = meeting.hasNotes ? "" : " (no meeting notes: thanks and the next step only)";
    return done === 0
      ? send("meeting_held_no_proposal", "meeting_recap", `meeting held (${meeting.outcome.replace(/_/g, " ")})${notes}`)
      : send("meeting_held_no_proposal", "check_in", "meeting held, recap already sent");
  }

  if (input.lastCallOrNoteAt) {
    if (!lastTouch || input.lastCallOrNoteAt > lastTouch) return send("after_call", "call_followup", "a rep logged a call or note since our last message");
    return journey("after_call", "continuing after the call");
  }
  return journey("new_no_contact", input.touches.length ? `message ${input.touches.length + 1}, no reply yet` : "first message");
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Rule 6: the next two working days (Mon–Sat) at least one day ahead, in IST, e.g. "Thursday or Friday". */
export function suggestedDays(now: Date): string {
  const days: string[] = [];
  let local = now.getTime() + IST_OFFSET_MS;
  while (days.length < 2) {
    local += DAY_MS;
    const weekday = new Date(local).getUTCDay();
    if (weekday !== 0) days.push(WEEKDAY_NAMES[weekday]!);
  }
  return days.join(" or ");
}
