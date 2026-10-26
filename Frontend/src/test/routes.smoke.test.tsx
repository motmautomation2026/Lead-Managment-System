import { cleanup, render } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Request failed"),
  useSession: () => ({ users: [], currentUser: null, userName: () => "Unassigned" }),
  useIsAdmin: () => false,
  useHomeSummary: () => ({
    data: {
      tasks: { overdue: 0, dueToday: 0, next: [] },
      meetings: { today: [], todayCount: 0, needsOutcome: 0 },
      deals: { openCount: 0, openAmount: 0, stages: [] },
      proposals: { awaitingDecision: 0 },
      ai: null,
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useAgentStats: () => ({ data: undefined, error: null }),
  useAgentDecisions: () => ({
    data: { pages: [] },
    isLoading: false,
    error: null,
    hasNextPage: false,
  }),
  useAgentDecision: () => ({ data: undefined, isLoading: false, error: null }),
}));

import { HomePage } from "@/features/home/home-page";
import { AiActivityPage } from "@/features/agent/ai-activity-page";

afterEach(cleanup);

async function renderScreen(Screen: () => ReactNode) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const screenRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Screen,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([screenRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(<RouterProvider router={router} />);
}

describe("zero-record route states", () => {
  it.each([
    [HomePage, "No open tasks. Nice."],
    [AiActivityPage, "No AI decisions match these filters."],
  ])("renders an empty backend dataset", async (Screen, expectedText) => {
    const view = await renderScreen(Screen);
    expect(view.container).toHaveTextContent(expectedText);
  });
});
