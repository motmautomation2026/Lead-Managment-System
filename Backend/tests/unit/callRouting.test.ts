import { describe, expect, it } from "vitest";
import { routeConnectedOutcome, routeNotConnected } from "../../src/domain/callRouting.js";

describe("routeNotConnected", () => {
  it("enrolls in Not Connected Nurture; the retry task comes from the LL-3 ladder (calls.service)", () => {
    const r = routeNotConnected("no_answer");
    expect(r.stage).toBe("not_connected_nurture");
    expect(r.automation).toBe("active");
    expect(r.workflowTrigger).toBe("call_not_connected");
    expect(r.task).toBeUndefined();
    expect(r.phoneContactStatus).toBeUndefined();
  });

  it("flags phone contactability on invalid_number without touching lifecycle", () => {
    const r = routeNotConnected("invalid_number");
    expect(r.phoneContactStatus).toBe("invalid");
    expect(r.stage).toBe("not_connected_nurture");
  });

  it("flags phone contactability on wrong_number (edge case: preserve other channels)", () => {
    const r = routeNotConnected("wrong_number");
    expect(r.phoneContactStatus).toBe("wrong_number");
  });
});

describe("routeConnectedOutcome", () => {
  it("routes Positive to Meeting Scheduling + Manual + schedule task, no nurture", () => {
    const r = routeConnectedOutcome("positive");
    expect(r.stage).toBe("meeting_scheduling");
    expect(r.automation).toBe("manual");
    expect(r.workflowTrigger).toBeUndefined();
    expect(r.task?.type).toBe("schedule_meeting");
  });

  it("routes Meeting Agreed to Meeting Scheduling + active automation + matching trigger", () => {
    const r = routeConnectedOutcome("meeting_agreed");
    expect(r.stage).toBe("meeting_scheduling");
    expect(r.automation).toBe("active");
    expect(r.workflowTrigger).toBe("meeting_agreed");
    expect(r.task).toMatchObject({ type: "schedule_meeting", dueInDays: 1 });
    expect(r.promptScheduleMeeting).toBe(true);
  });

  it("routes Interested - Later (the service requires the restart date; without one a 30-day fallback)", () => {
    const r = routeConnectedOutcome("interested_later");
    expect(r.stage).toBe("interested_later");
    expect(r.workflowTrigger).toBe("call_outcome_interested_later");
    expect(r.task).toMatchObject({ type: "call", title: "Call back — interested later", dueInDays: 30 });
  });

  it("LL-3 rule 5: the call-back task is due 09:30 IST on the restart date (a Sunday → Monday)", () => {
    expect(routeConnectedOutcome("interested_later", { restartAt: "2027-01-12" }).task?.dueAt).toEqual(new Date("2027-01-12T09:30:00+05:30"));
    expect(routeConnectedOutcome("interested_later", { restartAt: "2027-01-10" }).task?.dueAt).toEqual(new Date("2027-01-11T09:30:00+05:30"));
  });

  it("routes Future Possibility to a low-intensity 90-day check", () => {
    const r = routeConnectedOutcome("future_possibility");
    expect(r.stage).toBe("future_possibility");
    expect(r.workflowTrigger).toBe("call_outcome_future_possibility");
    expect(r.task).toMatchObject({ dueInDays: 90 });
  });

  it("routes Send Information to Connected - Qualifying with an active nurture sequence", () => {
    const r = routeConnectedOutcome("information_requested");
    expect(r.stage).toBe("connected_qualifying");
    expect(r.automation).toBe("active");
    expect(r.workflowTrigger).toBe("call_outcome_information_requested");
  });

  it.each([
    ["commission_only", "objection_commission_only"],
    ["internal_hiring", "objection_internal_hiring"],
    ["existing_team", "objection_existing_team"],
    ["budget_price", "objection_budget_price"],
    ["internal_approval", "objection_internal_approval"],
  ] as const)("routes %s objection to Objection Nurture + matching trigger", (outcome, trigger) => {
    const r = routeConnectedOutcome(outcome);
    expect(r.stage).toBe("objection_nurture");
    expect(r.objectionType).toBe(outcome);
    expect(r.workflowTrigger).toBe(trigger);
  });

  it("routes Wrong Fit to a manual archive/reroute task without nurture enrollment", () => {
    const r = routeConnectedOutcome("wrong_fit");
    expect(r.stage).toBeUndefined();
    expect(r.automation).toBe("manual");
    expect(r.objectionType).toBe("wrong_fit");
    expect(r.workflowTrigger).toBeUndefined();
  });

  it("routes Callback Requested to Manual with a callback task and does NOT touch stage", () => {
    const r = routeConnectedOutcome("callback_requested");
    expect(r.stage).toBeUndefined();
    expect(r.automation).toBe("manual");
    expect(r.task?.type).toBe("call");
    expect(r.workflowTrigger).toBeUndefined();
  });

  it("routes wrong_person to Connected - Qualifying without changing automation (preserve interaction)", () => {
    const r = routeConnectedOutcome("wrong_person");
    expect(r.stage).toBe("connected_qualifying");
    expect(r.automation).toBeUndefined();
    expect(r.task?.type).toBe("general_task");
  });
});
