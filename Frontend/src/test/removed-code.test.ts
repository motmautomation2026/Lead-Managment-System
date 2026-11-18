import { describe, expect, it } from "vitest";
import * as store from "@/store";
import { backend } from "@/lib/backend-client";

/**
 * C6b removed the old pages and their whole-table hooks. These fail if any comes back:
 * every list must go through the paginated list endpoints (C1-ui.md §1 rule 3).
 */
const REMOVED_HOOKS = [
  "useLeads",
  "useLeadList",
  "useTasks",
  "useMeetings",
  "useProposals",
  "useTimeline",
  "useDashboard",
];
const REMOVED_MODULES = [
  "features/dashboard/",
  "features/admin/",
  "features/leads/leads-page",
  "features/leads/lead-detail-page",
  "features/leads/add-lead-dialog",
  "features/leads/edit-lead-dialog",
];

const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("removed old pages and hooks (C6b)", () => {
  it("the store no longer exports the whole-table hooks", () => {
    for (const name of REMOVED_HOOKS) expect(Object.keys(store)).not.toContain(name);
  });

  it("no source file uses a removed hook or imports a removed page", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    const hook = new RegExp(`\\b(${REMOVED_HOOKS.join("|")})\\b`);
    for (const [file, text] of Object.entries(sources)) {
      expect(hook.test(text), `${file} uses a removed hook`).toBe(false);
      for (const module of REMOVED_MODULES)
        expect(text.includes(module), `${file} imports ${module}`).toBe(false);
    }
  });

  it("the client has no unpaginated list calls left", () => {
    expect(backend).not.toHaveProperty("dashboard");
    for (const group of [
      "leads",
      "tasks",
      "meetings",
      "proposals",
      "runs",
      "scheduledActions",
    ] as const)
      expect(backend[group]).not.toHaveProperty("list");
  });
});
