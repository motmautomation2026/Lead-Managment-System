import { describe, expect, it } from "vitest";
import { chooseNumber, moveProblem, NO_NUMBER_REASON, pickNumber, roomToday, type NumberCandidate } from "../../src/domain/whatsappNumbers.js";
import { DEFAULT_SEND_WINDOW, decideSend } from "../../src/domain/whatsappSafety.js";

const number = (id: string, over: Partial<NumberCandidate> = {}): NumberCandidate => ({
  id,
  label: `#${id}`,
  ownerUserId: null,
  connected: true,
  paused: false,
  removed: false,
  dailyCap: 200,
  warmupDay: null,
  sentToday: 0,
  newChatsToday: 0,
  pairedAt: null,
  ...over,
});

describe("E4a number choice (rule 4)", () => {
  it("takes the lead owner's number first, even with less room", () => {
    const numbers = [number("a", { sentToday: 5 }), number("b", { ownerUserId: "rep", sentToday: 150 })];
    expect(chooseNumber(numbers, "rep")).toBe("b");
  });

  it("owner's number paused, disconnected or full → the healthiest other number", () => {
    for (const owned of [{ paused: true }, { connected: false }, { sentToday: 200 }]) {
      const numbers = [number("own", { ownerUserId: "rep", ...owned }), number("x", { sentToday: 50 }), number("y", { sentToday: 10 })];
      expect(chooseNumber(numbers, "rep")).toBe("y");
    }
  });

  it("room counts the warm-up cap; ties → fewest new chats, then oldest pairing", () => {
    // Day 2 of warm-up: cap 20, 5 sent → room 15 < 100 left on the warmed number.
    expect(chooseNumber([number("new", { warmupDay: 2, sentToday: 5 }), number("old", { sentToday: 100 })], null)).toBe("old");
    expect(roomToday(number("w", { warmupDay: 2, sentToday: 5 }))).toBe(15);
    expect(chooseNumber([number("a", { newChatsToday: 4 }), number("b", { newChatsToday: 1 })], null)).toBe("b");
    const older = new Date("2026-01-01"), newer = new Date("2026-06-01");
    expect(chooseNumber([number("n", { pairedAt: newer }), number("o", { pairedAt: older })], null)).toBe("o");
    expect(chooseNumber([number("n", { pairedAt: newer }), number("pre-e1", { pairedAt: null })], null)).toBe("pre-e1");
  });

  it("no number available → wait", () => {
    const numbers = [number("a", { paused: true }), number("b", { connected: false }), number("c", { sentToday: 200 }), number("d", { removed: true })];
    expect(chooseNumber(numbers, null)).toBeNull();
    expect(pickNumber(null, numbers, null)).toEqual({ wait: NO_NUMBER_REASON, retryAfterMs: expect.any(Number) });
  });
});

describe("E4a sticky number (rules 3, 5)", () => {
  it("a lead without a number gets one assigned", () => {
    expect(pickNumber(null, [number("a")], null)).toEqual({ numberId: "a", assign: true });
  });

  it("the sticky number never changes automatically, even when another has more room", () => {
    const numbers = [number("sticky", { sentToday: 190 }), number("free")];
    expect(pickNumber("sticky", numbers, null)).toEqual({ numberId: "sticky", assign: false });
  });

  it("paused / disconnected / removed sticky number → wait, never a switch", () => {
    const others = [number("free")];
    expect(pickNumber("s", [number("s", { paused: true }), ...others], null)).toMatchObject({ wait: expect.stringMatching(/paused/) });
    expect(pickNumber("s", [number("s", { connected: false }), ...others], null)).toMatchObject({ wait: expect.stringMatching(/not connected/) });
    expect(pickNumber("s", [number("s", { removed: true }), ...others], null)).toMatchObject({ wait: expect.stringMatching(/removed/) });
  });

  it("a single-number workspace behaves as before: always that number", () => {
    expect(pickNumber(null, [number("only", { sentToday: 199 })], "rep")).toEqual({ numberId: "only", assign: true });
    expect(pickNumber("only", [number("only")], "rep")).toEqual({ numberId: "only", assign: false });
  });
});

describe("E4a move (rule 6)", () => {
  it("needs a reason and another existing number", () => {
    expect(moveProblem("a", number("b"), " ")).toMatch(/reason/);
    expect(moveProblem("a", undefined, "why")).toMatch(/doesn't exist/);
    expect(moveProblem("a", number("b", { removed: true }), "why")).toMatch(/doesn't exist/);
    expect(moveProblem("a", number("a"), "why")).toMatch(/already/);
    expect(moveProblem("a", number("b", { connected: false }), "why")).toBeNull();
    expect(moveProblem(null, number("b"), "why")).toBeNull();
  });
});

describe("E4a per-number new-chat limit", () => {
  const input = { source: "scheduled_action" as const, now: new Date("2026-11-02T10:00:00+05:30"), window: DEFAULT_SEND_WINDOW, dailyCap: 200, warmupDay: null, sentToday: 0, maxNewChatsPerDay: 20, newChatsToday: 20, text: "Hello", paused: false, nextSendAt: null, random: () => 0 };

  it("a new chat on this number counts against its limit even when the lead heard from us before (no opt-out line again)", () => {
    expect(decideSend({ ...input, isFirstMessage: false, isNewChat: true })).toMatchObject({ reason: expect.stringMatching(/New-chat limit/) });
    const ok = decideSend({ ...input, newChatsToday: 0, isFirstMessage: false, isNewChat: true });
    expect(ok).toMatchObject({ send: true, text: "Hello" });
  });

  it("without isNewChat the old workspace rule applies", () => {
    expect(decideSend({ ...input, isFirstMessage: true })).toMatchObject({ reason: expect.stringMatching(/New-chat limit/) });
    expect(decideSend({ ...input, isFirstMessage: false })).toMatchObject({ send: true });
  });
});
