import { describe, expect, it } from "vitest";
import { attemptLabel, isBadNumber, MAX_CALL_ATTEMPTS, nextAttemptDueAt, nextAttemptNumber } from "../../src/domain/callAttempts.js";
import { lossDetailsProblem, recoverAt, recoveryTaskTitle, RECOVERY_DAYS, triedCallingText, LOSS_REASON_CHOICES } from "../../src/domain/recovery.js";
import { datePassed, defaultValidUntil, expiryWarningAt, needsManagerReview, onboardingDueAt } from "../../src/domain/dealFollowUp.js";

const ist = (local: string) => new Date(`${local}:00+05:30`);
const DAY = 86_400_000;

describe("LL-3 retry ladder", () => {
  it("attempt 1 → +2 working hours", () => {
    expect(nextAttemptDueAt(1, ist("2026-11-17T11:00"))).toEqual(ist("2026-11-17T13:00"));
    // Ends exactly at closing → the next opening, never due at 19:00.
    expect(nextAttemptDueAt(1, ist("2026-11-17T17:00"))).toEqual(ist("2026-11-18T09:30"));
    // Saturday 18:00: 1 h on Saturday, 1 h on Monday.
    expect(nextAttemptDueAt(1, ist("2026-11-21T18:00"))).toEqual(ist("2026-11-23T10:30"));
    // Saturday evening and Sunday count from Monday's opening.
    expect(nextAttemptDueAt(1, ist("2026-11-21T20:00"))).toEqual(ist("2026-11-23T11:30"));
    expect(nextAttemptDueAt(1, ist("2026-11-22T10:00"))).toEqual(ist("2026-11-23T11:30"));
  });

  it("attempt 2 → next working day, the other half of the day", () => {
    expect(nextAttemptDueAt(2, ist("2026-11-17T11:00"))).toEqual(ist("2026-11-18T14:15"));
    expect(nextAttemptDueAt(2, ist("2026-11-17T16:00"))).toEqual(ist("2026-11-18T09:30"));
    expect(nextAttemptDueAt(2, ist("2026-11-21T11:00"))).toEqual(ist("2026-11-23T14:15"));
    expect(nextAttemptDueAt(2, ist("2026-11-21T20:00"))).toEqual(ist("2026-11-23T09:30"));
    expect(nextAttemptDueAt(2, ist("2026-11-22T10:00"))).toEqual(ist("2026-11-23T14:15"));
  });

  it("attempt 3 → +2 working days, attempt 4 → +4 working days", () => {
    expect(nextAttemptDueAt(3, ist("2026-11-17T11:00"))).toEqual(ist("2026-11-19T11:00"));
    expect(nextAttemptDueAt(3, ist("2026-11-21T20:00"))).toEqual(ist("2026-11-25T09:30"));
    expect(nextAttemptDueAt(4, ist("2026-11-17T11:00"))).toEqual(ist("2026-11-21T11:00"));
    expect(nextAttemptDueAt(4, ist("2026-11-22T10:00"))).toEqual(ist("2026-11-27T09:30"));
  });

  it("stops after 5 unanswered calls", () => {
    expect(MAX_CALL_ATTEMPTS).toBe(5);
    expect(nextAttemptDueAt(5, ist("2026-11-17T11:00"))).toBeNull();
    expect(attemptLabel(3)).toBe("Attempt 3 of 5");
  });

  it("counts consecutive unanswered calls; a reset starts again at 1", () => {
    expect(nextAttemptNumber(null, false)).toBe(1);
    expect(nextAttemptNumber({ attemptNumber: 2 }, false)).toBe(3);
    // A connected call / reply / booked meeting since the previous call.
    expect(nextAttemptNumber({ attemptNumber: 4 }, true)).toBe(1);
    // The previous call was answered (or a wrong number): no running count.
    expect(nextAttemptNumber({ attemptNumber: null }, false)).toBe(1);
  });

  it("busy / switched off count as No answer; wrong / invalid number stop the ladder", () => {
    expect(isBadNumber("busy")).toBe(false);
    expect(isBadNumber("switched_off")).toBe(false);
    expect(isBadNumber("wrong_number")).toBe(true);
    expect(isBadNumber("invalid_number")).toBe(true);
  });
});

describe("LL-3 recovery date by reason", () => {
  const lost = ist("2026-11-17T15:00");
  it("days by reason at 09:30 IST", () => {
    expect(recoverAt("price_budget", lost)).toEqual(ist("2026-12-17T09:30"));
    expect(recoverAt("no_response", lost)).toEqual(ist("2026-12-17T09:30"));
    expect(recoverAt("existing_supplier", lost)).toEqual(ist("2027-02-15T09:30"));
    expect(recoverAt("competitor_selected", lost)).toEqual(ist("2027-03-17T09:30"));
    // + 60 = Saturday 16 Jan: a working day.
    expect(recoverAt("no_requirement", lost)).toEqual(ist("2027-01-16T09:30"));
    expect(recoverAt("other", lost)).toEqual(ist("2027-01-16T09:30"));
  });
  it("a Sunday moves to Monday; postponed = the project date", () => {
    expect(recoverAt("price_budget", ist("2026-11-13T10:00"))).toEqual(ist("2026-12-14T09:30"));
    expect(recoverAt("project_postponed", lost, { projectDate: "2027-04-01" })).toEqual(ist("2027-04-01T09:30"));
  });
  it("every choice has a rule", () => {
    for (const reason of LOSS_REASON_CHOICES) expect(reason in RECOVERY_DAYS).toBe(true);
  });
  it("postponed needs a future project date", () => {
    expect(lossDetailsProblem("project_postponed", {}, lost)).toMatch(/project date is required/);
    expect(lossDetailsProblem("project_postponed", { projectDate: "2026-11-17" }, lost)).toMatch(/future/);
    expect(lossDetailsProblem("project_postponed", { projectDate: "2026-12-01" }, lost)).toBeNull();
    expect(lossDetailsProblem("competitor_selected", {}, lost)).toBeNull();
  });
  it("task title", () => {
    expect(recoveryTaskTitle("Asha Rao", lost, "competitor_selected", "Acme")).toBe("Re-engage: Asha Rao — lost 2026-11-17: Competitor (Acme)");
    expect(recoveryTaskTitle("Asha Rao", lost, "price_budget")).toBe("Re-engage: Asha Rao — lost 2026-11-17: Budget");
  });
});

describe("LL-3 tried-calling text", () => {
  it("fixed text, first names only; 'earlier' when sent on a later day", () => {
    const base = { firstName: "Asha", repName: "Ravi Kumar", workspaceName: "Northbeam", calledAt: ist("2026-11-17T11:00") };
    expect(triedCallingText({ ...base, now: ist("2026-11-17T11:02") })).toBe(
      "Hi Asha, this is Ravi from Northbeam. I tried calling you just now. When is a good time to talk? You can also reply here.",
    );
    expect(triedCallingText({ ...base, firstName: null, now: ist("2026-11-18T09:40") })).toBe(
      "Hi, this is Ravi from Northbeam. I tried calling you earlier. When is a good time to talk? You can also reply here.",
    );
  });
});

describe("LL-3 proposals and deals", () => {
  it("valid until = sent date (IST) + 30 days", () => {
    expect(defaultValidUntil(ist("2026-11-17T15:00"))).toBe("2026-12-17");
    expect(defaultValidUntil(ist("2026-11-17T00:30"))).toBe("2026-12-17");
  });
  it("expiry warning 3 working days before, skipping Sundays", () => {
    expect(expiryWarningAt("2026-12-17")).toEqual(ist("2026-12-14T09:30"));
    expect(expiryWarningAt("2026-12-15")).toEqual(ist("2026-12-11T09:30"));
  });
  it("a date has passed once the next IST day starts", () => {
    expect(datePassed("2026-11-17", ist("2026-11-17T23:59"))).toBe(false);
    expect(datePassed("2026-11-17", ist("2026-11-18T00:00"))).toBe(true);
  });
  it("manager review after > 10 idle days, once per 10 days", () => {
    const now = ist("2026-11-17T10:00");
    expect(needsManagerReview(new Date(now.getTime() - 11 * DAY), null, now)).toBe(true);
    expect(needsManagerReview(new Date(now.getTime() - 9 * DAY), null, now)).toBe(false);
    expect(needsManagerReview(new Date(now.getTime() - 25 * DAY), new Date(now.getTime() - 5 * DAY), now)).toBe(false);
    expect(needsManagerReview(new Date(now.getTime() - 25 * DAY), new Date(now.getTime() - 10 * DAY), now)).toBe(true);
  });
  it("onboarding is due the next working day", () => {
    expect(onboardingDueAt(ist("2026-11-17T15:00"))).toEqual(ist("2026-11-18T09:30"));
    expect(onboardingDueAt(ist("2026-11-21T15:00"))).toEqual(ist("2026-11-23T09:30"));
  });
});
