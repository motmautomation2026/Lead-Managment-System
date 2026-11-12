import { useEffect, useRef } from "react";

/**
 * Every keyboard shortcut, in one place: the shell runs them (`useShortcuts`) and the help
 * dialog lists them. `keys` is the sequence to press (a 2-key sequence must finish within
 * SEQUENCE_MS). Shortcuts never fire while typing, with a dialog/menu open, during a keyboard
 * drag, or with Ctrl/Alt/Meta held; the one exception is ⌘K / Ctrl+K (the palette).
 */
export const SHORTCUTS = [
  { id: "palette", keys: ["mod", "k"], label: "Search and commands", group: "General" },
  { id: "help", keys: ["?"], label: "Show keyboard shortcuts", group: "General" },
  { id: "search", keys: ["/"], label: "Search the current list", group: "General" },
  { id: "create", keys: ["n"], label: "Open the Create menu", group: "General" },
  { id: "goContacts", keys: ["g", "c"], label: "Go to Contacts", group: "Go to" },
  { id: "goCompanies", keys: ["g", "o"], label: "Go to Companies", group: "Go to" },
  { id: "goDeals", keys: ["g", "d"], label: "Go to Deals", group: "Go to" },
  { id: "goTasks", keys: ["g", "t"], label: "Go to Tasks", group: "Go to" },
  { id: "goMeetings", keys: ["g", "m"], label: "Go to Meetings", group: "Go to" },
  { id: "goProposals", keys: ["g", "p"], label: "Go to Proposals", group: "Go to" },
  { id: "goWorkflows", keys: ["g", "w"], label: "Go to Workflows", group: "Go to" },
  { id: "goAiActivity", keys: ["g", "a"], label: "Go to AI Activity", group: "Go to" },
  { id: "goKnowledge", keys: ["g", "k"], label: "Go to Knowledge", group: "Go to" },
  { id: "goSettings", keys: ["g", "s"], label: "Go to Settings", group: "Go to" },
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];
export const SEQUENCE_MS = 1000;

/**
 * Shown in the help sheet only: lists (DataTable) and the call queue handle these keys
 * themselves, with the same "not while typing / dialog open" rule (`keysAreTaken`).
 */
export const LOCAL_SHORTCUTS = [
  { id: "listNext", keys: ["j"], label: "Next row", group: "Lists" },
  { id: "listPrev", keys: ["k"], label: "Previous row", group: "Lists" },
  { id: "listOpen", keys: ["Enter"], label: "Open the row (peek)", group: "Lists" },
  { id: "listSelect", keys: ["x"], label: "Select the row", group: "Lists" },
  { id: "listClose", keys: ["Esc"], label: "Close the drawer", group: "Lists" },
  { id: "q1", keys: ["1"], label: "Connected", group: "Call queue" },
  { id: "q2", keys: ["2"], label: "No answer", group: "Call queue" },
  { id: "q3", keys: ["3"], label: "Busy", group: "Call queue" },
  { id: "q4", keys: ["4"], label: "Wrong number", group: "Call queue" },
  { id: "q5", keys: ["5"], label: "Call back at…", group: "Call queue" },
  { id: "qSkip", keys: ["s"], label: "Skip", group: "Call queue" },
  { id: "qPause", keys: ["p"], label: "Pause the queue", group: "Call queue" },
] as const;

/** Typing somewhere, or a dialog/menu/keyboard drag owns the keys. */
export function keysAreTaken(target: EventTarget | null) {
  const el = target instanceof HTMLElement ? target : null;
  if (
    el &&
    (el.isContentEditable || el.closest("input, textarea, select, [contenteditable='true']"))
  )
    return true;
  return Boolean(
    document.querySelector(
      // Open Radix dialogs/sheets/popovers/menus, and dnd-kit's item while it is being moved.
      "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox'], [aria-roledescription][aria-pressed='true']",
    ),
  );
}

/** Keydown → shortcut id (or null). Keeps the pending first key of a sequence between calls. */
export function createShortcutMatcher(now: () => number = Date.now) {
  let pending: { key: string; at: number } | null = null;
  return (e: KeyboardEvent): ShortcutId | null => {
    if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey) return "palette";
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return null;
    if (keysAreTaken(e.target)) {
      pending = null;
      return null;
    }
    const at = now();
    const first = pending && at - pending.at <= SEQUENCE_MS ? pending.key : null;
    pending = null;
    if (first) {
      const hit = SHORTCUTS.find((s) => s.keys[0] === first && s.keys[1] === e.key);
      if (hit) return hit.id;
    }
    if (SHORTCUTS.some((s) => s.keys.length === 2 && s.keys[0] === e.key)) {
      pending = { key: e.key, at };
      return null;
    }
    return SHORTCUTS.find((s) => s.keys.length === 1 && s.keys[0] === e.key)?.id ?? null;
  };
}

/** Runs the shell's handler for each shortcut pressed (window keydown). */
export function useShortcuts(handlers: Record<ShortcutId, () => void>) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const match = createShortcutMatcher();
    const onKey = (e: KeyboardEvent) => {
      const id = match(e);
      if (!id) return;
      e.preventDefault();
      latest.current[id]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** The element `/` focuses: each index/search page marks its search box with `data-list-search`. */
export function focusListSearch() {
  document.querySelector<HTMLInputElement>("[data-list-search]")?.focus();
}
