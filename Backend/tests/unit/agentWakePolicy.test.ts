import { describe, expect, it } from "vitest";
import { wakeFor } from "../../src/agent/wakePolicy.js";

const NOW = new Date("2026-10-27T05:30:00Z");
const after = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe("wakeFor", () => {
  it.each([
    ["lead_created", 5],
    ["meeting_booked", 10],
    ["meeting_rescheduled", 10],
    ["meeting_cancelled", 10],
    ["proposal_status", 10],
  ] as const)("%s wakes after %i minutes", (event, minutes) => {
    expect(wakeFor(event, NOW, { rep_quiet_hours: 24 })).toEqual({ reason: event, dueAt: after(minutes) });
  });

  it.each(["call_logged", "note_added", "meeting_outcome"] as const)("%s waits rep_quiet_hours", (event) => {
    expect(wakeFor(event, NOW, { rep_quiet_hours: 24 })).toEqual({ reason: event, dueAt: after(24 * 60) });
    expect(wakeFor(event, NOW, { rep_quiet_hours: 0 })).toEqual({ reason: event, dueAt: NOW });
  });
});
