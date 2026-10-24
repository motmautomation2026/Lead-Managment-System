import { describe, expect, it } from "vitest";
import { LIVE_MODE_UNAVAILABLE, settingsUpdateSchema } from "../../src/agent/settingsSchema.js";

const parse = (value: unknown) => settingsUpdateSchema.safeParse(value);
const messages = (value: unknown) => {
  const result = parse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe("agent settings update schema", () => {
  it("accepts a partial update and normalises times to HH:MM:SS", () => {
    const result = parse({ mode: "shadow", sendWindowStart: "08:00", sendWindowEnd: "18:30:00", sendDays: [1, 2, 3], repQuietHours: 0, decisionModel: null });
    expect(result.success && result.data).toEqual({ mode: "shadow", sendWindowStart: "08:00:00", sendWindowEnd: "18:30:00", sendDays: [1, 2, 3], repQuietHours: 0, decisionModel: null });
    expect(parse({}).success).toBe(true);
  });

  it("rejects live mode with a clear message", () => {
    expect(messages({ mode: "live" })).toEqual([LIVE_MODE_UNAVAILABLE]);
    expect(parse({ mode: "on" }).success).toBe(false);
  });

  it("rejects non-positive numbers and out-of-range quiet hours", () => {
    for (const field of ["minGapHours", "maxTouches7d", "maxTouchesTotal", "emailMaxWords", "whatsappMaxWords", "wakeMinDays", "wakeMaxDays", "monthlyBudgetUsd", "maxDecisionsPerDay"]) {
      expect(parse({ [field]: 0 }).success, field).toBe(false);
      expect(parse({ [field]: -1 }).success, field).toBe(false);
    }
    expect(parse({ minGapHours: 1.5 }).success).toBe(false);
    expect(parse({ monthlyBudgetUsd: 12.5 }).success).toBe(true);
    expect(parse({ maxDecisionsPerDay: 1.5 }).success).toBe(false);
    expect(parse({ maxDecisionsPerDay: 10_001 }).success).toBe(false);
    expect(parse({ maxDecisionsPerDay: 10_000 }).success).toBe(true);
    expect(parse({ repQuietHours: -1 }).success).toBe(false);
    expect(parse({ repQuietHours: 169 }).success).toBe(false);
    expect(parse({ repQuietHours: 168 }).success).toBe(true);
  });

  it("send days: 1-7, unique, non-empty", () => {
    expect(parse({ sendDays: [] }).success).toBe(false);
    expect(parse({ sendDays: [0] }).success).toBe(false);
    expect(parse({ sendDays: [8] }).success).toBe(false);
    expect(parse({ sendDays: [1, 1] }).success).toBe(false);
    expect(parse({ sendDays: [7, 1] }).success).toBe(true);
  });

  it("window start must be before end; wake min ≤ max", () => {
    expect(messages({ sendWindowStart: "19:00", sendWindowEnd: "09:30" })).toEqual(["The send window must end after it starts."]);
    expect(parse({ sendWindowStart: "10:00", sendWindowEnd: "10:00" }).success).toBe(false);
    expect(parse({ sendWindowStart: "25:00" }).success).toBe(false);
    expect(messages({ wakeMinDays: 5, wakeMaxDays: 2 })).toEqual(["Maximum wake days can't be less than minimum wake days."]);
    expect(parse({ wakeMinDays: 3, wakeMaxDays: 3 }).success).toBe(true);
  });

  it("company display name: trimmed, 1-120 chars, or null", () => {
    expect(parse({ companyDisplayName: "  MOTM Technologies " }).success && parse({ companyDisplayName: "  MOTM Technologies " }).data).toEqual({ companyDisplayName: "MOTM Technologies" });
    expect(parse({ companyDisplayName: null }).success).toBe(true);
    expect(parse({ companyDisplayName: "   " }).success).toBe(false);
    expect(parse({ companyDisplayName: "x".repeat(121) }).success).toBe(false);
  });

  it("opt-out texts can't be blank", () => {
    expect(parse({ emailOptOutText: "   " }).success).toBe(false);
    expect(parse({ whatsappOptOutText: "" }).success).toBe(false);
    expect(parse({ whatsappOptOutText: " Reply STOP " }).success).toBe(true);
  });
});
