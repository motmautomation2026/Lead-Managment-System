import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeSummary } from "@/types";

const mocks = vi.hoisted(() => ({
  summary: {} as { data?: HomeSummary; isLoading: boolean; error: Error | null },
  refetch: vi.fn(),
  openContact: vi.fn(),
  openTask: vi.fn(),
  openDeal: vi.fn(),
  funnel: undefined as unknown,
}));

vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/app/add-lead-context", () => ({
  useAddLead: () => ({ open: mocks.openContact }),
  useCreateTaskDialog: () => ({ open: mocks.openTask }),
  useCreateDealDialog: () => ({ open: mocks.openDeal }),
}));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useSession: () => ({ currentUser: { id: "u-1", name: "Asha Owner" } }),
  useHomeSummary: () => ({ ...mocks.summary, refetch: mocks.refetch }),
  useFunnel: () => ({ data: mocks.funnel, error: null }),
}));

import { HomePage } from "./home-page";

const summary = (over: Partial<HomeSummary> = {}): HomeSummary => ({
  tasks: {
    overdue: 3,
    dueToday: 2,
    next: [
      {
        id: "t-1",
        title: "Send the deck",
        dueAt: "2026-10-25T04:30:00.000Z",
        isOverdue: true,
        contact: { id: "l-1", name: "Ravi Kumar" },
      } as HomeSummary["tasks"]["next"][number],
    ],
  },
  meetings: {
    today: [
      {
        id: "m-1",
        title: "Discovery",
        at: "2026-10-26T09:30:00.000Z",
        meetLink: "https://meet.example/abc",
        contact: { id: "l-1", name: "Ravi Kumar" },
      } as HomeSummary["meetings"]["today"][number],
    ],
    todayCount: 1,
    needsOutcome: 4,
  },
  deals: {
    openCount: 5,
    openAmount: 2_500_000,
    stages: [
      { stage: "qualified", count: 3, amountTotal: 1_000_000 },
      { stage: "proposal_sent", count: 2, amountTotal: 1_500_000 },
    ],
  },
  proposals: { awaitingDecision: 6 },
  ai: { mode: "shadow", draftsToReview: 7 },
  ...over,
});

async function renderPage() {
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={new QueryClient()}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: HomePage }),
      page("/tasks"),
      page("/meetings"),
      page("/deals"),
      page("/proposals"),
      page("/ai-activity"),
      page("/contacts/$contactId"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Home" });
}
const hrefOf = (name: string | RegExp) =>
  decodeURIComponent(screen.getByRole("link", { name }).getAttribute("href") ?? "");

beforeEach(() => {
  mocks.summary = { data: summary(), isLoading: false, error: null };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HomePage (C6b)", () => {
  it("shows the backend's counts and links each to the matching list", async () => {
    await renderPage();
    const overdue = screen.getByRole("link", { name: "Overdue tasks" }).closest("div.rounded-md");
    expect(overdue).toHaveTextContent("3Overdue");
    expect(hrefOf("Overdue tasks")).toBe('/tasks?view=overdue&ownerId=["me"]&due=overdue');
    expect(hrefOf("Due today")).toBe('/tasks?view=today&ownerId=["me"]&due=today');
    expect(hrefOf("Meetings needing an outcome")).toContain("when=needs_outcome");
    expect(
      within(screen.getByRole("list", { name: "Open deals per stage" })).getAllByRole("listitem"),
    ).toHaveLength(2);
    expect(hrefOf("Open the board")).toContain("layout=board");
    expect(hrefOf("View proposals")).toContain("group=awaiting_decision");
    expect(screen.getByRole("link", { name: "View proposals" }).parentElement).toHaveTextContent(
      "6",
    );
    expect(hrefOf("Review in AI Activity")).toBe("/ai-activity?outcome=draft&rating=unrated");
    expect(
      screen.getByRole("link", { name: "Review in AI Activity" }).parentElement,
    ).toHaveTextContent("7");
    expect(screen.getByText("Send the deck")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Join Discovery" })).toHaveAttribute(
      "href",
      "https://meet.example/abc",
    );
  });

  it("hides the AI card while the agent is off; quick actions open the create dialogs", async () => {
    mocks.summary = { data: summary({ ai: null }), isLoading: false, error: null };
    await renderPage();
    expect(screen.queryByText("AI drafts to review")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Contact" }));
    fireEvent.click(screen.getByRole("button", { name: "Task" }));
    fireEvent.click(screen.getByRole("button", { name: "Deal" }));
    expect(mocks.openContact).toHaveBeenCalled();
    expect(mocks.openTask).toHaveBeenCalled();
    expect(mocks.openDeal).toHaveBeenCalled();
  });

  it("empty: no tasks, meetings or deals", async () => {
    mocks.summary = {
      data: summary({
        tasks: { overdue: 0, dueToday: 0, next: [] },
        meetings: { today: [], todayCount: 0, needsOutcome: 0 },
        deals: { openCount: 0, openAmount: 0, stages: [] },
      }),
      isLoading: false,
      error: null,
    };
    await renderPage();
    expect(screen.getByText("No open tasks. Nice.")).toBeTruthy();
    expect(screen.getByText("No meetings left today.")).toBeTruthy();
    expect(screen.getByText("No open deals")).toBeTruthy();
  });

  it("E3b-2b: the Conversion card shows the main number and the plain funnel; no leads → plain words", async () => {
    mocks.summary = { data: summary(), isLoading: false, error: null };
    const totals = {
      leadsCreated: 10,
      contacted: 8,
      firstMessageWithin15Min: { count: 4, pct: 40 },
      medianMinutesToFirstMessage: 12,
      emailsSent: 6,
      countedOpens: 2,
      replies: 3,
      positiveReplies: 1,
      meetingsBookedWithin14Days: 2,
      proposals: 1,
      won: 0,
    };
    mocks.funnel = {
      totals,
      websiteMeetingRate: { websiteLeads: 5, bookedWithin14Days: 2, pct: 40 },
      medianMinutesReplyToAnswer: 30,
      groups: [],
    };
    await renderPage();
    expect(screen.getByText("Conversion (last 30 days)")).toBeTruthy();
    expect(screen.getByText("40 %")).toBeTruthy();
    expect(screen.getByText(/of new website leads booked a meeting within 14 days/)).toBeTruthy();
    const funnel = screen.getByRole("list", { name: "Funnel" });
    expect(within(funnel).getByText("Contacted").parentElement?.textContent).toContain("8");
    cleanup();
    mocks.funnel = {
      totals: { ...totals, leadsCreated: 0 },
      websiteMeetingRate: { websiteLeads: 0, bookedWithin14Days: 0, pct: null },
      medianMinutesReplyToAnswer: null,
      groups: [],
    };
    await renderPage();
    expect(screen.getByText("No new leads in the last 30 days.")).toBeTruthy();
  });

  it("loading and error states", async () => {
    mocks.summary = { isLoading: true, error: null };
    await renderPage();
    expect(screen.getByLabelText("Loading Home")).toBeTruthy();
    cleanup();
    mocks.summary = { isLoading: false, error: new Error("Server down") };
    await renderPage();
    expect(screen.getByText("Server down")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetch).toHaveBeenCalled();
  });
});
