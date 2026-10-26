import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  defaultStringifySearch,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDecisionDetail,
  AgentDecisionFilters,
  AgentDecisionRow,
} from "@/lib/backend-client";

const mocks = vi.hoisted(() => ({
  filters: [] as AgentDecisionFilters[],
  rate: vi.fn(),
  fetchNextPage: vi.fn(),
}));

const row: AgentDecisionRow = {
  id: "d-1",
  createdAt: "2026-10-25T05:30:00.000Z",
  lead: { id: "l-1", name: "Asha Rao", company: "Tata" },
  ownerName: "Rep One",
  action: "send_email",
  outcome: "draft",
  subject: "Fleet follow-up",
  bodyPreview: "Hi Asha, following up…",
  regenerated: false,
  rating: null,
  ratingReason: null,
  openReports: 1,
};
const detail = {
  ...row,
  mode: "shadow",
  error: null,
  reasoning: "They asked for pricing.",
  messageSubject: "Fleet follow-up",
  messageBody: "Hi Asha",
  sendAt: null,
  nextWakeAt: null,
  handoffTitle: null,
  handoffUrgency: null,
  newStage: null,
  stopReason: null,
  rulesResult: null,
  groundingResult: null,
  playbookVersion: 1,
  decisionModel: null,
  groundingModel: null,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  ratingNote: null,
  ratedBy: null,
  ratedByName: null,
  ratedAt: null,
  leadId: "l-1",
  lead: { id: "l-1", name: "Asha Rao", company: "Tata", ownerId: "u-1" },
  composed: null,
  chunks: [],
  reports: [],
} as unknown as AgentDecisionDetail;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => false,
  useSession: () => ({ currentUser: { id: "u-1" } }),
  useAgentStats: () => ({
    data: {
      mode: "shadow",
      failed: 0,
      openReports: 1,
      spend: { month: "2026-10", spentUsd: 1, budgetUsd: 20 },
      readiness: { ready: false, rated: 3, goodPct: 100, seriousBad: 0, reasons: [] },
    },
    error: null,
  }),
  useAgentDecisions: (filters: AgentDecisionFilters) => {
    mocks.filters.push(filters);
    return {
      data: { pages: [{ data: [row], nextCursor: "x" }] },
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: mocks.fetchNextPage,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useAgentDecision: (id: string | null) => ({
    data: id ? detail : undefined,
    isLoading: false,
    error: null,
  }),
  useRateDecision: () => ({ mutate: mocks.rate, isPending: false }),
  useReportDecision: () => ({ mutate: vi.fn(), isPending: false }),
  useResolveReport: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AiActivityPage } from "./ai-activity-page";
import { validateAiActivitySearch } from "./ai-activity-search";

async function renderPage(search: Record<string, unknown> = {}) {
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={new QueryClient()}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/ai-activity",
        validateSearch: validateAiActivitySearch,
        component: AiActivityPage,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/contacts/$contactId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/ai-activity${defaultStringifySearch(search)}`],
    }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "AI Activity" });
  return router;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.filters = [];
});

describe("AiActivityPage (C6b)", () => {
  it("reads filters from the URL (Home's drafts-to-review link) and lists decisions in a table", async () => {
    await renderPage({ outcome: "draft", rating: "unrated", from: "2026-10-01" });
    expect(mocks.filters.at(-1)).toMatchObject({
      outcome: "draft",
      rating: "unrated",
      from: "2026-09-30T18:30:00.000Z",
    });
    const table = screen.getByRole("table", { name: "AI decisions" });
    expect(within(table).getByRole("link", { name: "Asha Rao" })).toHaveAttribute(
      "href",
      "/contacts/l-1",
    );
    expect(within(table).getByText("Fleet follow-up")).toBeTruthy();
    expect(within(table).getByText("1 open report")).toBeTruthy();
    expect(screen.getByText(/Shadow mode/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mocks.fetchNextPage).toHaveBeenCalled();
  });

  it("the open-reports card and the checkbox write openReport to the URL", async () => {
    const router = await renderPage();
    fireEvent.click(screen.getByTitle("Show decisions with an open report"));
    await waitFor(() =>
      expect((router.state.location.search as Record<string, unknown>)["openReport"]).toBe(true),
    );
    expect(mocks.filters.at(-1)?.hasOpenReport).toBe(true);
  });

  it("a row opens the decision Sheet; the lead's owner rates it with the same API call", async () => {
    await renderPage();
    fireEvent.click(screen.getByText("Fleet follow-up"));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Email for Asha Rao")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Good" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save rating" }));
    expect(mocks.rate).toHaveBeenCalledWith(
      { id: "d-1", input: { rating: "good", reason: undefined, note: undefined } },
      expect.anything(),
    );
  });
});
