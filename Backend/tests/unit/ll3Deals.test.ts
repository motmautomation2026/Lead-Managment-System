import { describe, expect, it } from "vitest";
import type { Actor } from "../../src/authMiddleware.js";
import { moveDeal, moveStageSchema } from "../../src/services/dealRecords.service.js";
import { DECISION_CANDIDATES_SQL, EXPIRED_CANDIDATES_SQL, EXPIRING_CANDIDATES_SQL, REVIEW_CANDIDATES_SQL } from "../../src/services/dealFollowUps.service.js";
import { WORKER_LOOPS } from "../../src/services/systemHealth.service.js";

const actor = { id: "u1", fullName: "Ravi", role: "salesperson" } as Actor;
const noDb = { query: () => Promise.reject(new Error("database reached")) } as never;

describe("LL-3 rule 9: deal stage moves", () => {
  it("negotiation needs a next decision date before anything is written", async () => {
    await expect(moveDeal(noDb, actor, "ws", "d1", moveStageSchema.parse({ stage: "negotiation" }))).rejects.toThrow(/next decision date is required/);
    await expect(moveDeal(noDb, actor, "ws", "d1", moveStageSchema.parse({ stage: "negotiation", nextDecisionDate: "2026-12-01" }))).rejects.toThrow(/database reached/);
    await expect(moveDeal(noDb, actor, "ws", "d1", moveStageSchema.parse({ stage: "proposal_sent" }))).rejects.toThrow(/database reached/);
  });
});

describe("LL-3 rule 9: follow-up worker guards", () => {
  it("each kind is once-only, bounded and fair", () => {
    expect(EXPIRING_CANDIDATES_SQL).toMatch(/x\.status = 'sent'.*x\.expiry_warned_at is null/s);
    expect(EXPIRED_CANDIDATES_SQL).toMatch(/x\.expired_task_at is null and x\.valid_until < /);
    expect(DECISION_CANDIDATES_SQL).toMatch(/x\.decision_task_for is distinct from x\.next_decision_date/);
    expect(REVIEW_CANDIDATES_SQL).toMatch(/x\.review_task_at is null or x\.review_task_at <= \$3::timestamptz - interval '10 days'/);
    for (const sql of [EXPIRING_CANDIDATES_SQL, EXPIRED_CANDIDATES_SQL, DECISION_CANDIDATES_SQL, REVIEW_CANDIDATES_SQL]) expect(sql).toMatch(/limit/i);
    expect(WORKER_LOOPS.deal_follow_ups).toBeDefined();
  });
});
