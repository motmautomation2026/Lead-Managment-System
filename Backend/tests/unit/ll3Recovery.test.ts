import { describe, expect, it } from "vitest";
import type { Actor } from "../../src/authMiddleware.js";
import { markDiscarded, markLost } from "../../src/services/leads.service.js";
import { WORKFLOW_LIFECYCLES } from "../../src/services/automation.service.js";
import { RECOVERY_DUE_SQL, RECOVERY_LEAD_SQL } from "../../src/services/leadRecovery.service.js";
import { DISCARD_REASONS } from "../../src/domain/recovery.js";
import { WORKER_LOOPS } from "../../src/services/systemHealth.service.js";

const actor = { id: "u1", fullName: "Ravi", role: "salesperson" } as Actor;
/** Fails the test if the service reaches the database: the check must come first. */
const noDb = { query: () => Promise.reject(new Error("database reached")) } as never;

describe("LL-3 rule 7: discard reason", () => {
  it("the reasons", () => {
    expect(DISCARD_REASONS).toEqual(["spam", "duplicate", "wrong_person", "not_a_sales_lead", "other"]);
  });
  it("'other' needs the text before anything is written", async () => {
    await expect(markDiscarded(noDb, actor, "ws", "lead", "other")).rejects.toThrow(/Say why/);
    await expect(markDiscarded(noDb, actor, "ws", "lead", "other", "  ")).rejects.toThrow(/Say why/);
    // A listed reason goes on to the database.
    await expect(markDiscarded(noDb, actor, "ws", "lead", "spam")).rejects.toThrow(/database reached/);
  });
});

describe("LL-3 rule 4/6: Lost details", () => {
  it("postponed without a project date is refused before anything is written", async () => {
    await expect(markLost(noDb, actor, "ws", "lead", "project_postponed")).rejects.toThrow(/project date is required/);
    await expect(markLost(noDb, actor, "ws", "lead", "competitor_selected", undefined, { competitorName: "Acme" })).rejects.toThrow(/database reached/);
  });
});

describe("LL-3 rule 8: workflows in long-term nurture", () => {
  it("steps run for active and long-term nurture leads only", () => {
    expect(WORKFLOW_LIFECYCLES).toEqual(["active", "long_term_nurture"]);
  });
});

describe("LL-3 rule 6: recovery worker guards", () => {
  it("once per loss, due only, fair and bounded", () => {
    expect(RECOVERY_DUE_SQL).toMatch(/x\.lifecycle_state = 'lost' and x\.recovered_at is null/);
    expect(RECOVERY_DUE_SQL).toMatch(/x\.recover_at <= \$1/);
    expect(RECOVERY_LEAD_SQL).toMatch(/for update of l/);
    expect(WORKER_LOOPS.lost_recovery).toBeDefined();
  });
  it("skips DNC and opted out on both channels", () => {
    expect(RECOVERY_LEAD_SQL).toMatch(/c\.status = 'do_not_contact'/);
    expect(RECOVERY_LEAD_SQL).toMatch(/'whatsapp' and c\.status = 'opted_out'\)\s+and exists .*'email' and c\.status = 'unsubscribed'/s);
  });
});
