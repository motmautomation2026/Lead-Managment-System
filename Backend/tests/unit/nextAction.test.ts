import { describe, expect, it } from "vitest";
import {
  batchBells,
  needsNextAction,
  resolveResponsible,
  sweepBellTitle,
  sweepTask,
  type NextActionFacts,
} from "../../src/domain/nextAction.js";

const base: NextActionFacts = {
  lifecycle: "active",
  openTasks: 0,
  futureMeeting: false,
  automationMode: "active",
  workflowStepPending: false,
  ai: { status: "none", live: false, touches: 0, maxTouches: 8 },
};
const ai = (over: Partial<NextActionFacts["ai"]>) => ({ ...base, ai: { ...base.ai, status: "active" as const, live: true, ...over } });

describe("LL-1 rule 2: needsNextAction", () => {
  it("active lead with nothing → needs one; long-term nurture too", () => {
    expect(needsNextAction(base)).toBe(true);
    expect(needsNextAction({ ...base, lifecycle: "long_term_nurture" })).toBe(true);
  });

  it("DNC, merged and terminal lifecycles never", () => {
    for (const lifecycle of ["do_not_contact", "merged", "won", "lost", "discarded"] as const) {
      expect(needsNextAction({ ...base, lifecycle })).toBe(false);
    }
  });

  it("an open task or a future meeting covers it", () => {
    expect(needsNextAction({ ...base, openTasks: 1 })).toBe(false);
    expect(needsNextAction({ ...base, futureMeeting: true })).toBe(false);
  });

  it("workflow: a pending step covers it only while it can run (active / long-term nurture lifecycle, automation active)", () => {
    expect(needsNextAction({ ...base, workflowStepPending: true })).toBe(false);
    for (const automationMode of ["manual", "paused", "stopped"] as const) {
      expect(needsNextAction({ ...base, workflowStepPending: true, automationMode })).toBe(true);
    }
    // LL-3 rule 8: workflows run in long-term nurture too.
    expect(needsNextAction({ ...base, lifecycle: "long_term_nurture", workflowStepPending: true })).toBe(false);
    expect(needsNextAction({ ...base, lifecycle: "long_term_nurture", workflowStepPending: true, automationMode: "stopped" })).toBe(true);
  });

  it("AI: active + live + touches left covers it", () => {
    expect(needsNextAction(ai({ touches: 7 }))).toBe(false);
  });

  it("AI stopped, handed off, paused, out of touches or shadow does not", () => {
    expect(needsNextAction(ai({ status: "stopped" }))).toBe(true);
    expect(needsNextAction(ai({ status: "handed_off" }))).toBe(true);
    expect(needsNextAction(ai({ status: "paused" }))).toBe(true);
    expect(needsNextAction(ai({ touches: 8 }))).toBe(true);
    expect(needsNextAction(ai({ live: false }))).toBe(true);
  });
});

describe("LL-1 rule 3: sweep task", () => {
  const now = new Date("2026-11-16T10:00:00Z");
  it("active → follow_up 'Decide the next step' due now", () => {
    expect(sweepTask("active", now)).toEqual({ type: "follow_up", title: "Decide the next step", dueAt: now });
  });
  it("long-term nurture → re_engage 'Plan re-engagement' due +45 d", () => {
    expect(sweepTask("long_term_nurture", now)).toEqual({ type: "re_engage", title: "Plan re-engagement", dueAt: new Date("2026-12-31T10:00:00Z") });
  });
});

describe("LL-1 rule 1: resolveResponsible", () => {
  const owner = { id: "o1", name: "Asha", active: true, member: true };
  it("active member owner → owned task, owner bell", () => {
    expect(resolveResponsible({ owner, adminIds: ["a1"] })).toEqual({ ownerId: "o1", ownerName: "Asha", notify: ["o1"] });
  });
  it("inactive owner, owner not a member, or no owner → unowned task, admins' bell", () => {
    const admins = { ownerId: null, ownerName: null, notify: ["a1", "a2"] };
    expect(resolveResponsible({ owner: { ...owner, active: false }, adminIds: ["a1", "a2"] })).toEqual(admins);
    expect(resolveResponsible({ owner: { ...owner, member: false }, adminIds: ["a1", "a2"] })).toEqual(admins);
    expect(resolveResponsible({ owner: null, adminIds: ["a1", "a2", "a1"] })).toEqual(admins);
  });
});

describe("LL-1 rule 3: batched bells", () => {
  it("one bell per person per workspace with the count", () => {
    const bells = batchBells([
      { workspaceId: "w1", notify: ["o1"] },
      { workspaceId: "w1", notify: ["o1"] },
      { workspaceId: "w1", notify: ["a1", "a2"] },
      { workspaceId: "w2", notify: ["o1"] },
    ]);
    expect(bells).toEqual([
      { workspaceId: "w1", recipientId: "o1", count: 2 },
      { workspaceId: "w1", recipientId: "a1", count: 1 },
      { workspaceId: "w1", recipientId: "a2", count: 1 },
      { workspaceId: "w2", recipientId: "o1", count: 1 },
    ]);
    expect(sweepBellTitle(3)).toBe("3 leads need a next step");
    expect(sweepBellTitle(1)).toBe("1 lead needs a next step");
  });
});
