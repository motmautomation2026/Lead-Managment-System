import { describe, expect, it } from "vitest";
import { formatMoney } from "@/lib/format";

describe("formatMoney", () => {
  it("uses Indian grouping for INR", () => {
    expect(formatMoney(1250000)).toBe("₹12,50,000");
    expect(formatMoney(999.5)).toBe("₹999.5");
  });

  it("uses lakh / crore when compact", () => {
    expect(formatMoney(1250000, "INR", true)).toBe("₹12.5 L");
    expect(formatMoney(12500000, "INR", true)).toBe("₹1.25 Cr");
    expect(formatMoney(50000, "INR", true)).toBe("₹50,000");
    expect(formatMoney(-1250000, "INR", true)).toBe("-₹12.5 L");
  });

  it("handles missing amounts and other currencies", () => {
    expect(formatMoney(null)).toBe("–");
    expect(formatMoney(1000, "USD")).toBe("$1,000");
  });
});
