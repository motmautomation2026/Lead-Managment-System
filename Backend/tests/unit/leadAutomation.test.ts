/** REL-1: which leads are automated, and every automatic job's query carries the guard. */
import { describe, expect, it } from "vitest";
import { isAutomated } from "../../src/domain/automation.js";
import { AUTOMATED_SQL, NOT_BEFORE_OPT_IN_SQL } from "../../src/services/leadAutomation.service.js";
import { DUE_CANDIDATES_SQL, ESCALATION_CANDIDATES_SQL } from "../../src/services/taskReminders.service.js";
import { SWEEP_CANDIDATES_SQL, SWEEP_COUNTS_SQL } from "../../src/services/nextAction.service.js";
import { RECOVERY_DUE_SQL } from "../../src/services/leadRecovery.service.js";
import { DECISION_CANDIDATES_SQL, EXPIRED_CANDIDATES_SQL, EXPIRING_CANDIDATES_SQL, REVIEW_CANDIDATES_SQL } from "../../src/services/dealFollowUps.service.js";
import { PLAN_CANDIDATES_SQL } from "../../src/services/meetingReminders.service.js";
import { DIGEST_CANDIDATES_SQL } from "../../src/services/staffAlerts.service.js";
import { ENQUEUE_SQL, FACTS_SQL } from "../../src/services/triedCalling.service.js";
import { liveContactSql } from "../../src/services/agentSendState.service.js";

const cutoff = new Date("2026-11-18T12:00:00+05:30");
const before = new Date(cutoff.getTime() - 1);

describe("isAutomated (rule 1)", () => {
  it.each([
    // created, switch, expected
    [cutoff, null, true],
    [before, null, false],
    [before, true, true],
    [cutoff, false, false],
    [before, false, false],
  ] as const)("created %s, switch %s → %s", (createdAt, automationEnabled, expected) => {
    expect(isAutomated({ createdAt, automationEnabled }, { automationSince: cutoff })).toBe(expected);
  });
});

describe("SQL mirror", () => {
  it("is the same rule: the switch wins, else created at/after the workspace cutoff", () => {
    expect(AUTOMATED_SQL("l")).toBe(
      "coalesce(l.automation_enabled, l.created_at >= (select a.automation_since from public.agent_settings a where a.workspace_id = l.workspace_id))",
    );
    expect(NOT_BEFORE_OPT_IN_SQL("al", "x.due_at")).toBe("(al.automation_enabled is not true or x.due_at >= al.automation_set_at)");
  });

  it.each([
    ["AI live scope", liveContactSql("s.live_scope"), "l"],
    ["safety-net sweep", SWEEP_CANDIDATES_SQL, "l"],
    ["sweep dry-run counts", SWEEP_COUNTS_SQL, "l"],
    ["due bells", DUE_CANDIDATES_SQL, "al"],
    ["escalations", ESCALATION_CANDIDATES_SQL, "al"],
    ["lost recovery", RECOVERY_DUE_SQL, "x"],
    ["proposal expiring", EXPIRING_CANDIDATES_SQL, "al"],
    ["proposal expired", EXPIRED_CANDIDATES_SQL, "al"],
    ["decision date", DECISION_CANDIDATES_SQL, "al"],
    ["manager review", REVIEW_CANDIDATES_SQL, "al"],
    ["meeting reminders", PLAN_CANDIDATES_SQL, "al"],
    ["digest items", DIGEST_CANDIDATES_SQL, "l"],
    ["we tried calling (queue)", ENQUEUE_SQL, "l"],
    ["we tried calling (send)", FACTS_SQL, "l"],
  ])("%s carries the guard", (_name, sql, alias) => {
    expect(sql).toContain(AUTOMATED_SQL(alias));
  });

  it("due bells and digest items still count tasks a person created on any lead; escalations never back-date", () => {
    expect(DUE_CANDIDATES_SQL).toContain(`x.origin = 'manual' or ${AUTOMATED_SQL("al")}`);
    expect(DIGEST_CANDIDATES_SQL).toContain(`t.origin = 'manual' or ${AUTOMATED_SQL("l")}`);
    expect(ESCALATION_CANDIDATES_SQL).toContain(NOT_BEFORE_OPT_IN_SQL("al", "x.due_at"));
  });

  it("switching on counts as fresh activity for the sweep (one next-step task, nothing replayed)", () => {
    expect(SWEEP_CANDIDATES_SQL).toContain("l.automation_set_at >= coalesce($3::timestamptz, s.next_action_sweep_since)");
  });
});
