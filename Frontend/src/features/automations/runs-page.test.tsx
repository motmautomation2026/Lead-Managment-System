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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RunListItem,
  RunListParams,
  ScheduledActionListItem,
  ScheduledActionListParams,
} from "@/types";

const mocks = vi.hoisted(() => ({
  runParams: [] as RunListParams[],
  stepParams: [] as ScheduledActionListParams[],
  runs: [] as RunListItem[],
  steps: [] as ScheduledActionListItem[],
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  act: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useContact: (id: string) => ({
    data: id ? { id, firstName: "Ravi", lastName: "Kumar" } : undefined,
  }),
  useContactSearch: () => ({ data: undefined, isFetching: false, isError: false }),
  useWorkflowList: () => ({ data: { data: [{ id: "w-1", name: "Nurture" }] } }),
  useRunList: (params: RunListParams, enabled: boolean) => {
    if (enabled) mocks.runParams.push(params);
    return {
      data: { pages: [{ data: mocks.runs, nextCursor: null }] },
      hasNextPage: mocks.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: mocks.fetchNextPage,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useScheduledActionList: (params: ScheduledActionListParams, enabled: boolean) => {
    if (enabled) mocks.stepParams.push(params);
    const rows = params.runId
      ? mocks.steps.filter((s) => s.workflowRunId === params.runId)
      : mocks.steps;
    return {
      data: { pages: [{ data: rows, nextCursor: null }] },
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useRunCount: () => ({ data: { count: 12 } }),
  useScheduledActionCount: () => ({ data: { count: 30 } }),
  useRunAction: () => ({ mutateAsync: mocks.act, isPending: false }),
}));

import { RunsPage } from "./runs-page";
import { validateRunsSearch } from "./runs-search";

const run = (
  id: string,
  status: RunListItem["status"],
  extra: Partial<RunListItem> = {},
): RunListItem => ({
  id,
  workflowId: "w-1",
  version: 3,
  leadId: "l-1",
  status,
  startedAt: "2026-10-20T10:00:00.000Z",
  nextRunAt: "2026-10-27T10:00:00.000Z",
  contact: { id: "l-1", name: "Ravi Kumar" },
  workflow: { id: "w-1", name: "Nurture" },
  currentStepAction: "send_email",
  ...extra,
});
const step = (id: string, runId: string): ScheduledActionListItem => ({
  id,
  leadId: "l-1",
  workflowRunId: runId,
  workflowStepId: "s-1",
  actionType: "send_whatsapp",
  scheduledFor: "2026-10-27T10:00:00.000Z",
  status: "pending",
  payload: {},
  attemptCount: 0,
  maxAttempts: 3,
  contact: { id: "l-1", name: "Ravi Kumar" },
  workflow: { id: "w-1", name: "Nurture" },
  stepOrder: 1,
});

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
        path: "/automations/runs",
        validateSearch: validateRunsSearch,
        component: RunsPage,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/contacts/$contactId",
        component: () => null,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/automations/workflows/$workflowId",
        component: () => null,
      }),
      createRoute({ getParentRoute: () => root, path: "/automations", component: () => null }),
      createRoute({
        getParentRoute: () => root,
        path: "/automations/templates",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/automations/runs${defaultStringifySearch(search)}`],
    }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Runs" });
  return router;
}
const searchOf = (router: Awaited<ReturnType<typeof renderPage>>) =>
  router.state.location.search as Record<string, unknown>;

beforeEach(() => {
  mocks.runParams = [];
  mocks.stepParams = [];
  mocks.hasNextPage = false;
  mocks.runs = [run("r-1", "waiting"), run("r-2", "failed", { lastError: "SMTP down" })];
  mocks.steps = [step("a-1", "r-1"), step("a-2", "r-2")];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RunsPage (C6b)", () => {
  it("lists runs from the server list; URL filters reach the API; Load more pages", async () => {
    mocks.hasNextPage = true;
    await renderPage({
      workflowId: "w-1",
      runStatus: ["failed"],
      contactId: "l-1",
      from: "2026-10-01T00:00:00+05:30",
      to: "2026-10-31T23:59:59+05:30",
      q: "ravi",
    });
    expect(mocks.runParams.at(-1)).toEqual({
      workflowId: "w-1",
      status: ["failed"],
      contactId: "l-1",
      startedFrom: "2026-10-01T00:00:00+05:30",
      startedTo: "2026-10-31T23:59:59+05:30",
      q: "ravi",
      sort: "startedAt:desc",
    });
    expect(screen.getByRole("tab", { name: /Runs/ })).toBeTruthy();
    const table = screen.getByRole("table", { name: "Workflow runs" });
    expect(within(table).getAllByText("Nurture · V3")).toHaveLength(2);
    expect(within(table).getByText("SMTP down")).toBeTruthy();
    expect(within(table).getAllByRole("link", { name: "Ravi Kumar" })[0]).toHaveAttribute(
      "href",
      "/contacts/l-1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mocks.fetchNextPage).toHaveBeenCalled();
  });

  it("Scheduled steps tab lists steps with their own params; search writes q to the URL", async () => {
    const router = await renderPage({ tab: "steps", stepStatus: ["pending"] });
    expect(mocks.stepParams.at(-1)).toMatchObject({
      status: ["pending"],
      sort: "scheduledFor:asc",
    });
    const table = screen.getByRole("table", { name: "Scheduled steps" });
    expect(within(table).getAllByText("2 · Send Whatsapp")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Search runs"), { target: { value: "ravi" } });
    await waitFor(() => expect(searchOf(router)["q"]).toBe("ravi"));
    fireEvent.click(screen.getByRole("tab", { name: /^Runs/ }));
    await waitFor(() => expect(searchOf(router)["tab"]).toBeUndefined());
  });

  it("row Sheet: details, step history, and the same actions per status (Retry on failed, Pause on waiting)", async () => {
    mocks.act.mockResolvedValue({});
    await renderPage();
    fireEvent.click(screen.getAllByText("SMTP down")[0]!);
    let sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Step history")).toBeTruthy();
    expect(mocks.stepParams).toContainEqual({ runId: "r-2", sort: "scheduledFor:asc", limit: 50 });
    expect(within(sheet).getByText("Step 2 · Send Whatsapp")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.act).toHaveBeenCalledWith({ id: "r-2", action: "retry" }));
    expect(mocks.toast.success).toHaveBeenCalledWith("Run retried");
    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeTruthy();

    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getAllByText("Send Email")[0]!);
    sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(mocks.act).toHaveBeenCalledWith({ id: "r-1", action: "pause" }));
  });

  it("shows the empty state when nothing matches", async () => {
    mocks.runs = [];
    await renderPage();
    expect(screen.getByText("No workflow runs")).toBeTruthy();
  });
});
