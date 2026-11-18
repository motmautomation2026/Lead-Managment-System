import { describe, expect, it } from "vitest";
import { goLiveReadiness, MIN_GOOD_PCT, MIN_RATED } from "../../src/agent/readiness.js";

describe("goLiveReadiness", () => {
  it("uses the documented thresholds", () => {
    expect([MIN_RATED, MIN_GOOD_PCT]).toEqual([50, 90]);
  });

  it("nothing rated: not ready, goodPct null", () => {
    const r = goLiveReadiness({ good: 0, badByReason: {} });
    expect(r).toMatchObject({ ready: false, rated: 0, goodPct: null, seriousBad: 0 });
    expect(r.reasons).toHaveLength(2);
  });

  it("49 rated, all good: not ready; 50 rated, all good: ready", () => {
    expect(goLiveReadiness({ good: 49, badByReason: {} })).toMatchObject({ ready: false, rated: 49, goodPct: 100 });
    expect(goLiveReadiness({ good: 50, badByReason: {} })).toEqual({ ready: true, rated: 50, goodPct: 100, seriousBad: 0, reasons: [] });
  });

  it("89.9 % good: not ready; exactly 90 %: ready", () => {
    const below = goLiveReadiness({ good: 899, badByReason: { wrong_tone: 101 } });
    expect(below).toMatchObject({ ready: false, rated: 1000, goodPct: 89.9 });
    expect(below.reasons).toEqual(["At least 90% of rated decisions must be good (89.9% now)."]);
    expect(goLiveReadiness({ good: 45, badByReason: { wrong_timing: 3, other: 2 } })).toMatchObject({ ready: true, rated: 50, goodPct: 90 });
  });

  it("89.95 % (displayed as 90) is still below the gate", () => {
    expect(goLiveReadiness({ good: 1799, badByReason: { wrong_action: 201 } })).toMatchObject({ ready: false, goodPct: 90 });
  });

  it("one serious bad blocks go-live even with enough good ratings", () => {
    for (const reason of ["made_up_fact", "internal_info_leak"] as const) {
      const r = goLiveReadiness({ good: 99, badByReason: { [reason]: 1 } });
      expect(r).toMatchObject({ ready: false, rated: 100, goodPct: 99, seriousBad: 1 });
      expect(r.reasons).toHaveLength(1);
    }
    expect(goLiveReadiness({ good: 99, badByReason: { wrong_tone: 1 } }).ready).toBe(true);
  });
});
