import { afterEach, describe, expect, it } from "vitest";
import { createShortcutMatcher, SHORTCUTS } from "./shortcuts";

const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const e = new KeyboardEvent("keydown", { key: k, cancelable: true, ...init });
  Object.defineProperty(e, "target", { value: target });
  return e;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("shortcut matcher", () => {
  it("single keys and g-sequences within 1 s", () => {
    let t = 0;
    const match = createShortcutMatcher(() => t);
    expect(match(key("?", { shiftKey: true }))).toBe("help");
    expect(match(key("/"))).toBe("search");
    expect(match(key("n"))).toBe("create");
    expect(match(key("g"))).toBeNull();
    t = 900;
    expect(match(key("d"))).toBe("goDeals");
    expect(match(key("g"))).toBeNull();
    t = 2000;
    expect(match(key("c"))).toBeNull(); // too late
    expect(match(key("x"))).toBeNull();
  });

  it("every registry entry is reachable", () => {
    const match = createShortcutMatcher(() => 0);
    for (const s of SHORTCUTS) {
      const hit =
        s.keys[0] === "mod"
          ? match(key("k", { ctrlKey: true }))
          : s.keys.map((k) => match(key(k))).at(-1);
      expect(hit).toBe(s.id);
    }
  });

  it("⌘K / Ctrl+K always; other modifiers, fields, open dialogs/menus and keyboard drags block the rest", () => {
    const match = createShortcutMatcher(() => 0);
    expect(match(key("k", { metaKey: true }))).toBe("palette");
    expect(match(key("n", { ctrlKey: true }))).toBeNull();
    expect(match(key("n", { altKey: true }))).toBeNull();
    const input = document.createElement("textarea");
    document.body.append(input);
    expect(match(key("n", {}, input))).toBeNull();
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.append(editable);
    expect(match(key("/", {}, editable))).toBeNull();
    document.body.innerHTML = '<div role="dialog"></div>';
    expect(match(key("n"))).toBeNull();
    document.body.innerHTML = '<div role="menu"></div>';
    expect(match(key("?"))).toBeNull();
    document.body.innerHTML =
      '<button aria-roledescription="sortable" aria-pressed="true"></button>';
    expect(match(key("n"))).toBeNull();
    document.body.innerHTML = "";
    const prevented = key("n");
    prevented.preventDefault();
    expect(match(prevented)).toBeNull();
    expect(match(key("n"))).toBe("create");
  });
});
