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

const taskItem = (id: string, title: string, contact: string, isOverdue = false) =>
  ({
    id,
    title,
    dueAt: "2026-10-25T04:30:00.000Z",
    isOverdue,
    contact: { id: `l-${id}`, name: contact },
  }) as HomeSummary["tasks"]["next"][number];

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
    overdueTop: [taskItem("t-2", "Chase the PO", "Ravi Kumar", true)],
  },
  replies: {
    count: 2,
    top: [taskItem("t-3", "Lead replied on WhatsApp — respond today", "Mira Shah")],
  },
  calls: { count: 4, top: [taskItem("t-4", "First call", "Neha Joshi")] },
  nextSteps: { count: 1, top: [taskItem("t-5", "Decide the next step", "Arun Rao")] },
  team: null,
  flags: null,
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
      page("/tasks/calls"),
      page("/tasks/replies"),
      page("/settings/email"),
      page("/settings/whatsapp"),
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

describe("HomePage (UX-3 My day)", () => {
  it("greeting + date; each card's count, top items and link to its queue", async () => {
    await renderPage();
    expect(screen.getByText(/^Good (morning|afternoon|evening), Asha · /)).toBeTruthy();
    const card = (title: string) =>
      screen.getByText(title).closest("div.rounded-xl, div.rounded-lg")!;
    expect(screen.getByLabelText("2 replies waiting")).toBeTruthy();
    expect(within(card("Replies waiting") as HTMLElement).getByText("Mira Shah")).toBeTruthy();
    expect(hrefOf("Open the Replies queue")).toBe("/tasks/replies");
    expect(screen.getByLabelText("4 calls due today / overdue")).toBeTruthy();
    expect(hrefOf("Start calling")).toBe("/tasks/calls");
    expect(screen.getByLabelText("1 decide the next step")).toBeTruthy();
    expect(hrefOf("All next-step tasks")).toBe(
      '/tasks?view=mine&ownerId=["me"]&q=Decide+the+next+step',
    );
    expect(screen.getByLabelText("3 overdue tasks")).toBeTruthy();
    expect(screen.getByText("Chase the PO")).toBeTruthy();
    expect(hrefOf("All overdue tasks")).toBe('/tasks?view=overdue&ownerId=["me"]&due=overdue');
    expect(hrefOf("Due today")).toBe('/tasks?view=today&ownerId=["me"]&due=today');
    expect(hrefOf("All meetings today")).toBe('/meetings?view=today&when=today&ownerId=["me"]');
    expect(hrefOf("4 need an outcome")).toContain("when=needs_outcome");
    expect(screen.getByRole("link", { name: "Join Discovery" })).toHaveAttribute(
      "href",
      "https://meet.example/abc",
    );
    expect(
      within(screen.getByRole("list", { name: "Open deals per stage" })).getAllByRole("listitem"),
    ).toHaveLength(2);
    expect(hrefOf("View proposals")).toContain("group=awaiting_decision");
    expect(hrefOf("Review in AI Activity")).toBe("/ai-activity?outcome=draft&rating=unrated");
    // A salesperson's summary has no team row and no red flags.
    expect(screen.queryByRole("table", { name: "Team" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Red flags" })).toBeNull();
  });

  it("empty cards say what's good", async () => {
    mocks.summary = {
      data: summary({
        tasks: { overdue: 0, dueToday: 0, next: [], overdueTop: [] },
        meetings: { today: [], todayCount: 0, needsOutcome: 0 },
        deals: { openCount: 0, openAmount: 0, stages: [] },
        replies: { count: 0, top: [] },
        calls: { count: 0, top: [] },
        nextSteps: { count: 0, top: [] },
      }),
      isLoading: false,
      error: null,
    };
    await renderPage();
    for (const text of [
      "No replies waiting.",
      "No calls due. You're up to date.",
      "No meetings left today.",
      "No contacts waiting for a next step.",
      "Nothing overdue. Nice.",
      "No open deals",
    ])
      expect(screen.getByText(text)).toBeTruthy();
  });

  it("admins: the team row and this workspace's red flags (incl. no mailbox)", async () => {
    mocks.summary = {
      data: summary({
        team: [
          { id: "u-2", name: "Ravi Rep", openTasks: 9, overdue: 2, replies: 1 },
          { id: "u-3", name: "Neha Rep", openTasks: 3, overdue: 0, replies: 0 },
        ],
        flags: [
          { code: "stuck_queue", text: "Messages are stuck in the send queue." },
          { code: "staff_email_no_mailbox", text: "Staff email alerts are off: no mailbox." },
        ],
      }),
      isLoading: false,
      error: null,
    };
    await renderPage();
    const team = screen.getByRole("table", { name: "Team" });
    expect(
      within(team)
        .getAllByRole("row")
        .map((r) => r.textContent),
    ).toEqual(["RepOpen tasksOverdueReplies waiting", "Ravi Rep921", "Neha Rep300"]);
    expect(within(team).getByRole("link", { name: "Ravi Rep" }).getAttribute("href")).toContain(
      "ownerId",
    );
    const flags = screen.getByRole("region", { name: "Red flags" });
    expect(flags).toHaveTextContent("Messages are stuck in the send queue.");
    expect(within(flags).getByRole("link", { name: "Settings → Email" })).toHaveAttribute(
      "href",
      "/settings/email",
    );
    cleanup();
    mocks.summary = { data: summary({ team: [], flags: [] }), isLoading: false, error: null };
    await renderPage();
    expect(screen.getByText("No red flags in this workspace.")).toBeTruthy();
    // LL-3b: an admin's next-step and overdue cards also link to unowned tasks (e.g. "Manager review").
    expect(hrefOf("All overdue tasks")).toBe(
      '/tasks?view=overdue&ownerId=["me","none"]&due=overdue',
    );
    expect(hrefOf("All next-step tasks")).toBe(
      '/tasks?view=mine&ownerId=["me","none"]&q=Decide+the+next+step',
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
