import type { PillTone } from "@/components/crm/status-pill";
import type { MeetingListItem, MeetingStatus } from "@/types";

/** Display tones only; status rules live in the backend. */
export const MEETING_STATUS_TONE: Record<MeetingStatus, PillTone> = {
  tentative: "neutral",
  scheduled: "info",
  confirmed: "info",
  rescheduled: "warning",
  completed: "success",
  cancelled: "neutral",
  no_show: "danger",
  failed: "danger",
};

/** The meeting's join link: the Meet link from Calendar, else the URL typed in. */
export const joinLink = (m: Pick<MeetingListItem, "meetLink" | "url">) => m.meetLink || m.url;

/** Record outcome is offered until the meeting is completed or cancelled (B33 unchanged). */
export const canRecordOutcome = (m: Pick<MeetingListItem, "status">) =>
  m.status !== "completed" && m.status !== "cancelled";
