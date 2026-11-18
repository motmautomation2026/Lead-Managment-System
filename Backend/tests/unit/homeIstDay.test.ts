import { describe, expect, it } from "vitest";
import { istDayEndIso } from "../../src/services/home.service.js";

describe("istDayEndIso (Home calls due today or overdue)", () => {
  it("is the last millisecond of the IST day", () => {
    // 17 Nov 2026 10:00 IST → 17 Nov 23:59:59.999 IST = 18:29:59.999 UTC.
    expect(istDayEndIso(new Date("2026-11-17T04:30:00Z"))).toBe("2026-11-17T18:29:59.999Z");
    // 23:30 IST is still the same IST day; 00:10 IST is the next one.
    expect(istDayEndIso(new Date("2026-11-17T18:00:00Z"))).toBe("2026-11-17T18:29:59.999Z");
    expect(istDayEndIso(new Date("2026-11-17T18:40:00Z"))).toBe("2026-11-18T18:29:59.999Z");
  });
});
