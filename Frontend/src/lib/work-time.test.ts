import { describe, expect, it } from "vitest";
import { defaultCallbackSlot } from "./dates";
import { isStillSending, sendingPollInterval, SENDING_POLL_INTERVAL_MS } from "./proposal-sending";

describe("defaultCallbackSlot (B13)", () => {
  it("today 10:00 IST while it is still ahead", () => {
    // 09:00 IST on Monday 26 Oct 2026.
    expect(defaultCallbackSlot(new Date("2026-10-26T03:30:00Z"))).toEqual({
      date: "2026-10-26",
      time: "10:00",
    });
  });
  it("the next working day once 10:00 IST has passed", () => {
    // 10:30 IST Monday → Tuesday.
    expect(defaultCallbackSlot(new Date("2026-10-26T05:00:00Z"))).toEqual({
      date: "2026-10-27",
      time: "10:00",
    });
    // 18:00 IST Friday 30 Oct → Monday 2 Nov.
    expect(defaultCallbackSlot(new Date("2026-10-30T12:30:00Z")).date).toBe("2026-11-02");
    // 23:59 IST Saturday (still Saturday in IST, already Saturday 18:29 UTC) → Monday.
    expect(defaultCallbackSlot(new Date("2026-10-31T18:29:00Z")).date).toBe("2026-11-02");
  });
});

describe("proposal send polling (B19)", () => {
  const now = Date.parse("2026-10-26T10:00:00Z");
  const row = (status: "sending" | "queued" | "sent", agoMs: number) => ({
    whatsappSendStatus: status,
    updatedAt: new Date(now - agoMs).toISOString(),
  });

  it("polls while a send is in flight for under 2 minutes", () => {
    expect(sendingPollInterval([row("sent", 0), row("sending", 60_000)], now)).toBe(
      SENDING_POLL_INTERVAL_MS,
    );
    expect(sendingPollInterval([row("queued", 0)], now)).toBe(SENDING_POLL_INTERVAL_MS);
  });

  it("stops after 2 minutes and marks the row as still sending", () => {
    const stuck = row("sending", 120_000);
    expect(sendingPollInterval([stuck, row("sent", 0)], now)).toBe(false);
    expect(isStillSending(stuck, now)).toBe(true);
    expect(isStillSending(row("sending", 119_000), now)).toBe(false);
    expect(isStillSending(row("sent", 600_000), now)).toBe(false);
  });
});
