import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RECENTS, readRecents, rememberRecent } from "./recent-records";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("recent records", () => {
  it("keeps newest first, moves a reopened record to the front, caps at 8, per workspace", () => {
    for (let i = 0; i < 10; i++)
      rememberRecent("ws-1", { type: "deal", id: `d${i}`, label: `D${i}` });
    rememberRecent("ws-1", { type: "deal", id: "d5", label: "D5 renamed" });
    const recents = readRecents("ws-1");
    expect(recents).toHaveLength(MAX_RECENTS);
    expect(recents[0]).toEqual({ type: "deal", id: "d5", label: "D5 renamed" });
    expect(recents.map((r) => r.id)).toEqual(["d5", "d9", "d8", "d7", "d6", "d4", "d3", "d2"]);
    expect(readRecents("ws-2")).toEqual([]);
    expect(readRecents(null)).toEqual([]);
  });

  it("stores only type, id and label; same id of another type is a separate record", () => {
    rememberRecent("ws-1", { type: "contact", id: "x", label: "Asha", email: "a@x" } as never);
    rememberRecent("ws-1", { type: "company", id: "x", label: "Acme" });
    expect(JSON.parse(window.localStorage.getItem("motmflow.recent.ws-1")!)).toEqual([
      { type: "company", id: "x", label: "Acme" },
      { type: "contact", id: "x", label: "Asha" },
    ]);
  });

  it("survives broken or blocked storage", () => {
    window.localStorage.setItem("motmflow.recent.ws-1", "{not json");
    expect(readRecents("ws-1")).toEqual([]);
    window.localStorage.setItem(
      "motmflow.recent.ws-1",
      JSON.stringify([{ type: "x", id: 1 }, "s"]),
    );
    expect(readRecents("ws-1")).toEqual([]);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readRecents("ws-1")).toEqual([]);
    expect(() => rememberRecent("ws-1", { type: "deal", id: "d", label: "D" })).not.toThrow();
  });
});
