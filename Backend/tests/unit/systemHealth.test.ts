import { describe, expect, it } from "vitest";
import { CRITICAL_LOOPS, healthVerdict, redProblems } from "../../src/services/systemHealth.service.js";
import { fairPickSql } from "../../src/services/fairPick.js";

const now = new Date("2026-11-10T12:00:00Z");
const fresh = (loop: string, secondsAgo = 10, expected = 60) => ({ loop, last_finished_at: new Date(now.getTime() - secondsAgo * 1000), expected_seconds: expected });

describe("P7 /health/worker verdict", () => {
  it("ok while every critical loop finished within 3× its expected interval", () => {
    expect(healthVerdict(CRITICAL_LOOPS.map((l) => fresh(l, 179)), now)).toEqual({ status: "ok", stale: [] });
  });

  it("stale names the critical loops that are late or missing; background loops never count", () => {
    const rows = CRITICAL_LOOPS.filter((l) => l !== "email_outbound").map((l) => fresh(l, l === "agent_tick" ? 181 : 5));
    expect(healthVerdict([...rows, fresh("company_sweep", 9_999)], now)).toEqual({ status: "stale", stale: ["email_outbound", "agent_tick"] });
    expect(healthVerdict([{ loop: "agent_tick", last_finished_at: null, expected_seconds: 60 }], now).stale).toContain("agent_tick");
  });
});

describe("P7 red problems", () => {
  const base = { emailStuck: 0, emailWaiting: 9, whatsappStuck: 0, whatsappWaiting: 9, overdueWakeups: 3, pausedNumbers: 0, emailPaused: false, failedSends24h: 2, budgetUsedPct: 89.9, decisionsToday: 0, decisionCap: 1, decisionCapUsedPct: 0 };
  it("waiting rows, overdue wake-ups and failures alone are not red", () => {
    expect(redProblems(base)).toEqual([]);
  });
  it("stuck queue, paused channel, budget ≥ 90 %", () => {
    expect(redProblems({ ...base, whatsappStuck: 1, emailPaused: true, budgetUsedPct: 90 })).toEqual(["stuck_queue", "paused_channel", "ai_budget"]);
    expect(redProblems({ ...base, pausedNumbers: 2 })).toEqual(["paused_channel"]);
  });
});

describe("P7 fair pick", () => {
  it("ranks each workspace's rows and takes every workspace's first before anyone's second", () => {
    const sql = fairPickSql({ from: "public.t x", where: "x.due", order: "x.due_at", limit: "$1" });
    expect(sql).toContain("row_number() over (partition by x.workspace_id order by x.due_at, x.id)");
    expect(sql).toContain("order by fair.fair_rn, fair.fair_at, fair.k");
    expect(sql).toContain("limit $1");
  });
});
