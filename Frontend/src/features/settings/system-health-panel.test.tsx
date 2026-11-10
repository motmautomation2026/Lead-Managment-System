import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ systemHealth: vi.fn() }));

vi.mock("@/lib/backend-client", () => ({
  backend: { superAdmin: { systemHealth: mocks.systemHealth } },
}));
vi.mock("@/store", async () => {
  const { keys } = await import("@/store/query");
  return {
    keys,
    messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  };
});

import { SystemHealthPanel } from "./system-health-panel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPanel = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SystemHealthPanel />
    </QueryClientProvider>,
  );

const workspace = {
  workspaceId: "ws-1",
  name: "MOTM",
  emailStuck: 2,
  emailWaiting: 5,
  whatsappStuck: 0,
  whatsappWaiting: 3,
  overdueWakeups: 1,
  pausedNumbers: 1,
  emailPaused: false,
  failedSends24h: 4,
  budgetUsedPct: 91.5,
  decisionsToday: 12,
  decisionCap: 200,
  decisionCapUsedPct: 6,
  red: ["stuck_queue", "paused_channel", "ai_budget"] as const,
};

describe("Settings → System health (P7)", () => {
  it("shows each loop's state and every workspace's queues, pauses and budget", async () => {
    mocks.systemHealth.mockResolvedValue({
      status: "stale",
      stale: ["agent_tick"],
      loops: [
        {
          loop: "email_outbound",
          critical: true,
          lastStartedAt: "",
          lastFinishedAt: "",
          ageSeconds: 12,
          expectedSeconds: 60,
          lastError: null,
          lastErrorAt: null,
          itemsProcessed: 3,
        },
        {
          loop: "agent_tick",
          critical: true,
          lastStartedAt: "",
          lastFinishedAt: "",
          ageSeconds: 600,
          expectedSeconds: 60,
          lastError: null,
          lastErrorAt: null,
          itemsProcessed: 0,
        },
        {
          loop: "company_sweep",
          critical: false,
          lastStartedAt: "",
          lastFinishedAt: "",
          ageSeconds: 20,
          expectedSeconds: 60,
          lastError: "ECONNRESET",
          lastErrorAt: "",
          itemsProcessed: 0,
        },
      ],
      workspaces: [
        workspace,
        {
          ...workspace,
          workspaceId: "ws-2",
          name: "Quiet",
          emailStuck: 0,
          pausedNumbers: 0,
          budgetUsedPct: 10,
          red: [],
        },
      ],
    });
    renderPanel();

    expect((await screen.findByText("Worker")).textContent).toContain("Stale");
    expect(screen.getByText("agent tick").closest("tr")?.textContent).toContain("Stale");
    expect(screen.getByText("email outbound").closest("tr")?.textContent).toContain("12 s ago");
    expect(screen.getByText("ECONNRESET")).toBeTruthy();

    const motm = screen.getByText("MOTM").closest("tr")!;
    expect(motm.textContent).toContain("Stuck queue");
    expect(motm.textContent).toContain("Paused channel");
    expect(motm.textContent).toContain("AI budget ≥ 90 %");
    expect(motm.textContent).toContain("2 / 5");
    expect(motm.textContent).toContain("1 number(s)");
    expect(motm.textContent).toContain("91.5 %");
    expect(motm.textContent).toContain("12 / 200 (6 %)");
    expect(screen.getByText("Quiet").closest("tr")?.textContent).toContain("OK");
  });

  it("shows the empty and error states", async () => {
    mocks.systemHealth.mockResolvedValueOnce({
      status: "stale",
      stale: [],
      loops: [],
      workspaces: [],
    });
    renderPanel();
    expect(await screen.findByText("No heartbeats yet")).toBeTruthy();
    expect(screen.getByText("No active workspaces")).toBeTruthy();
    cleanup();

    mocks.systemHealth.mockRejectedValueOnce(new Error("You don't have access"));
    renderPanel();
    expect(await screen.findByText("You don't have access")).toBeTruthy();
  });
});
