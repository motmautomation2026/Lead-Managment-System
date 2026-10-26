import { describe, expect, it } from "vitest";
import { allowedNextProposalStatuses, PROPOSAL_STATUS_GROUPS, routeProposalStatus, TERMINAL_PROPOSAL_STATUSES } from "../../src/domain/proposalRouting.js";
import { PROPOSAL_STATUSES } from "../../src/domain/enums.js";

describe("routeProposalStatus", () => {
  it("Sent -> Proposal Decision Pending + follow-up task + proposal_pending trigger", () => {
    const r = routeProposalStatus("sent");
    expect(r.stage).toBe("proposal_decision_pending");
    expect(r.task).toMatchObject({ type: "proposal_follow_up", dueInDays: 3 });
    expect(r.workflowTrigger).toBe("proposal_pending");
  });

  it("Accepted -> Won + cancel all open tasks, no stage change (lifecycle overrides stage)", () => {
    const r = routeProposalStatus("accepted");
    expect(r.lifecycle).toBe("won");
    expect(r.cancelAllOpenTasks).toBe(true);
    expect(r.stage).toBeUndefined();
  });

  it("Rejected -> safe default of Long-Term Nurture, not Lost", () => {
    const r = routeProposalStatus("rejected");
    expect(r.lifecycle).toBe("long_term_nurture");
    expect(r.task).toMatchObject({ dueInDays: 45 });
    expect(r.cancelOpenProposalFollowUps).toBe(true);
  });

  it("Draft/Uploaded/etc. have no automatic pipeline/lifecycle effect", () => {
    expect(routeProposalStatus("draft")).toEqual({});
    expect(routeProposalStatus("uploaded")).toEqual({});
    expect(routeProposalStatus("ready_to_send")).toEqual({});
  });
});

describe("allowedNextProposalStatuses", () => {
  it("terminal statuses allow nothing", () => {
    for (const s of TERMINAL_PROPOSAL_STATUSES) expect(allowedNextProposalStatuses(s)).toEqual([]);
  });
  it("an open status allows every other status, never itself", () => {
    const next = allowedNextProposalStatuses("sent");
    expect(next).not.toContain("sent");
    expect(next).toHaveLength(PROPOSAL_STATUSES.length - 1);
    expect(next).toEqual(expect.arrayContaining(["accepted", "rejected", "expired", "revision_requested"]));
  });
  it("groups cover every status once, except sent (open + awaiting decision)", () => {
    const { open, won, lost, awaiting_decision } = PROPOSAL_STATUS_GROUPS;
    expect([...open, ...won, ...lost].sort()).toEqual([...PROPOSAL_STATUSES].sort());
    expect(awaiting_decision.every((s) => (open as readonly string[]).includes(s))).toBe(true);
  });
});
