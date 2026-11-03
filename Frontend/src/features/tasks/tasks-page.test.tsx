import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import type { SavedView, TaskListItem, TaskListParams, WorkflowTrigger } from "@/types";

const mocks = vi.hoisted(() => ({
  listParams: [] as TaskListParams[],
  countParams: [] as TaskListParams[],
  rows: [] as TaskListItem[],
  hasNextPage: false,
  isLoading: false,
  error: null as Error | null,
  fetchNextPage: vi.fn(),
  complete: vi.fn(),
  update: vi.fn(),
  cancel: vi.fn(),
  backendComplete: vi.fn(),
  backendUpdate: vi.fn(),
  openCreate: vi.fn(),
  createView: vi.fn(),
  views: [] as SavedView[],
  toast: { success: vi.fn(), error: vi.fn() },
}));

const task = (id: string, title: string, extra: Partial<TaskListItem> = {}): TaskListItem => ({
  id,
  leadId: "l-1",
  ownerId: "u-1",
  ownerName: "Asha Owner",
  type: "follow_up",
  title,
  dueAt: "2026-10-26T04:30:00.000Z",
  status: "open",
  done: false,
  origin: "manual",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  contact: { id: "l-1", name: "Ravi Kumar" },
  company: { id: "co-1", name: "Acme" },
  isOverdue: false,
  ...extra,
});

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/app/add-lead-context", () => ({
  useCreateTaskDialog: () => ({ open: mocks.openCreate }),
}));
vi.mock("@/lib/backend-client", () => ({
  backend: { tasks: { complete: mocks.backendComplete, update: mocks.backendUpdate } },
}));
// Stand-ins for the dialogs LogCallFlow mounts: they expose the prompts it wires (B12).
vi.mock("@/features/leads/log-call-dialog", () => ({
  LogCallDialog: (props: {
    open: boolean;
    taskId?: string;
    onOpenChange: (open: boolean) => void;
    onEnrollPrompt?: (t: WorkflowTrigger) => void;
    onScheduleMeetingPrompt?: (t?: WorkflowTrigger) => void;
  }) =>
    props.open ? (
      <div role="dialog" aria-label="Log call">
        call for task {props.taskId}
        {/* Like the real dialog: close first, then prompt. */}
        <button
          onClick={() => {
            props.onOpenChange(false);
            props.onScheduleMeetingPrompt?.("meeting_scheduled");
          }}
        >
          outcome positive
        </button>
        <button
          onClick={() => {
            props.onOpenChange(false);
            props.onEnrollPrompt?.("call_not_connected");
          }}
        >
          outcome nurture
        </button>
      </div>
    ) : null,
}));
vi.mock("@/features/leads/scheduled-followups", () => ({
  EnrollWorkflowDialog: (props: { open: boolean; triggerFilter?: string }) =>
    props.open ? <div role="dialog">enroll {props.triggerFilter}</div> : null,
}));
vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  refreshWork: vi.fn(async () => undefined),
  useIsAdmin: () => false,
  // E3b-2a: the reply task's Sheet asks for the contact's suggested reply (none here).
  useLatestReplyDraft: () => ({ data: { draft: null } }),
  useReplyDraftActions: () => ({ send: { mutate: vi.fn() }, discard: { mutate: vi.fn() } }),
  useSession: () => ({
    users: [
      { id: "u-1", name: "Asha Owner", active: true },
      { id: "u-2", name: "Ravi Rep", active: true },
    ],
  }),
  useCompany: (id: string | undefined) => ({ data: id ? { id, name: "Acme" } : undefined }),
  useCompanySearch: () => ({ data: undefined }),
  useCreateCompany: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useContact: (id: string) => ({
    data: id ? { id, firstName: "Ravi", lastName: "Kumar" } : undefined,
  }),
  useContactSearch: () => ({ data: undefined, isFetching: false, isError: false }),
  useDeal: (id: string | undefined) => ({ data: id ? { id, name: "Acme deal" } : undefined }),
  useTaskList: (params: TaskListParams) => {
    mocks.listParams.push(params);
    return {
      data: { pages: [{ data: mocks.rows, nextCursor: null }] },
      hasNextPage: mocks.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: mocks.fetchNextPage,
      isLoading: mocks.isLoading,
      error: mocks.error,
      refetch: vi.fn(),
    };
  },
  useTaskCount: (params: TaskListParams) => {
    mocks.countParams.push(params);
    return { data: { count: params.due === "overdue" ? 3 : params.due === "today" ? 2 : 9 } };
  },
  useCompleteTask: () => ({ mutate: mocks.complete }),
  useUpdateTask: () => ({ mutateAsync: mocks.update, isPending: false }),
  useCancelTask: () => ({ mutateAsync: mocks.cancel, isPending: false }),
  useCreateMeeting: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateMeeting: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSavedViews: () => ({ data: { data: mocks.views } }),
  useCreateSavedView: () => ({ mutateAsync: mocks.createView, isPending: false }),
  useUpdateSavedView: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSavedView: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { TasksPage } from "./tasks-page";
import { validateTasksSearch } from "./tasks-search";

async function renderPage(search: Record<string, unknown> = {}) {
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={new QueryClient()}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <div>at {path}</div> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/tasks",
        validateSearch: validateTasksSearch,
        component: TasksPage,
      }),
      page("/contacts/$contactId"),
      page("/companies/$companyId"),
      page("/deals/$dealId"),
    ]),
    history: createMemoryHistory({ initialEntries: [`/tasks${defaultStringifySearch(search)}`] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Tasks" });
  return router;
}
const lastList = () => mocks.listParams[mocks.listParams.length - 1]!;
const searchOf = (router: Awaited<ReturnType<typeof renderPage>>) =>
  router.state.location.search as Record<string, unknown>;

beforeEach(() => {
  mocks.listParams = [];
  mocks.countParams = [];
  mocks.views = [];
  mocks.hasNextPage = false;
  mocks.isLoading = false;
  mocks.error = null;
  mocks.rows = [
    task("t-1", "Send the deck", { isOverdue: true }),
    task("t-2", "First call", { type: "call", origin: "agent" }),
  ];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TasksPage", () => {
  it("defaults to My open; Overdue and Due today show counts and switch the view", async () => {
    const router = await renderPage();
    // A bare /tasks is replaced by the default view.
    await waitFor(() => expect(searchOf(router)).toEqual({ view: "mine", ownerId: ["me"] }));
    expect(lastList()).toEqual({ ownerId: ["me"], sort: "dueAt:asc", q: undefined });
    expect(router.history.length).toBe(1);
    const tabs = screen.getByRole("tablist", { name: "Views" });
    expect(within(tabs).getByRole("tab", { name: /^My open/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(tabs).getByRole("tab", { name: /^Overdue\s*3$/ })).toBeTruthy();
    expect(within(tabs).getByRole("tab", { name: /^Due today\s*2$/ })).toBeTruthy();
    expect(screen.getByText("9")).toBeTruthy();

    fireEvent.click(within(tabs).getByRole("tab", { name: /^Overdue\s*3$/ }));
    await waitFor(() =>
      expect(searchOf(router)).toMatchObject({ view: "overdue", due: "overdue" }),
    );
    expect(lastList()).toMatchObject({ ownerId: ["me"], due: "overdue" });
    fireEvent.click(within(tabs).getByRole("tab", { name: "All open" }));
    await waitFor(() => expect(searchOf(router)["ownerId"]).toBeUndefined());
  });

  it("filters, search and sort live in the URL and reach the API", async () => {
    const router = await renderPage({
      ownerId: ["u-2"],
      type: ["call"],
      origin: ["agent"],
      status: "all",
      dueFrom: "2026-10-01T00:00:00+05:30",
      dueTo: "2026-10-31T23:59:59+05:30",
      companyId: "co-1",
      contactId: "l-1",
      sort: "createdAt:desc",
    });
    expect(lastList()).toEqual({
      ownerId: ["u-2"],
      type: ["call"],
      origin: ["agent"],
      status: "all",
      dueFrom: "2026-10-01T00:00:00+05:30",
      dueTo: "2026-10-31T23:59:59+05:30",
      companyId: "co-1",
      contactId: "l-1",
      q: undefined,
      sort: "createdAt:desc",
    });
    expect(screen.getByRole("button", { name: "Contact filter" })).toHaveTextContent("Ravi Kumar");
    fireEvent.click(screen.getByRole("button", { name: "Clear contact filter" }));
    await waitFor(() => expect(searchOf(router)["contactId"]).toBeUndefined());

    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "deck" } });
    await waitFor(() => expect(searchOf(router)["q"]).toBe("deck"));
    expect(lastList().q).toBe("deck");

    fireEvent.click(within(screen.getByRole("columnheader", { name: /^Due/ })).getByRole("button"));
    await waitFor(() => expect(searchOf(router)["sort"]).toBe("dueAt:asc"));
  });

  it("has no Deal column (tasks have no deal link); a deal's View all is labelled as its contact's tasks", async () => {
    await renderPage({ view: "everyone", dealId: "d-1", columns: ["title", "contact", "deal"] });
    expect(lastList().dealId).toBe("d-1");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent ?? "");
    expect(headers.some((h) => h.includes("Deal"))).toBe(false);
    expect(screen.getByText("Tasks of this deal's contact: Acme deal")).toBeTruthy();
  });

  it("shows overdue due dates in red, loads more, and has empty and error states", async () => {
    mocks.hasNextPage = true;
    await renderPage();
    const overdueRow = screen.getByText("Send the deck").closest("tr")!;
    expect(within(overdueRow).getByRole("time")).toHaveClass("text-destructive");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mocks.fetchNextPage).toHaveBeenCalled();
    cleanup();

    mocks.rows = [];
    mocks.hasNextPage = false;
    await renderPage({ view: "today", ownerId: ["me"], due: "today" });
    expect(screen.getByText("No tasks due today.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Create task" }).at(-1)!);
    expect(mocks.openCreate).toHaveBeenCalled();
    cleanup();

    mocks.error = new Error("Server down");
    await renderPage();
    expect(await screen.findByText("Server down")).toBeTruthy();
  });

  it("saves the current list as a view (object tasks)", async () => {
    mocks.createView.mockResolvedValue({ id: "v-1" });
    await renderPage({ view: "overdue", ownerId: ["me"], due: "overdue", type: ["call"] });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    const dialog = await screen.findByRole("dialog", { name: "Save view" });
    fireEvent.change(within(dialog).getByLabelText("View name"), {
      target: { value: "Overdue calls" },
    });
    fireEvent.submit(within(dialog).getByLabelText("View name"));
    await waitFor(() =>
      expect(mocks.createView).toHaveBeenCalledWith(
        expect.objectContaining({
          object: "tasks",
          name: "Overdue calls",
          filters: { ownerId: ["me"], due: "overdue", type: ["call"] },
        }),
      ),
    );
  });

  it("Done completes a plain task; a call task opens Log call instead", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark Send the deck done" }));
    expect(mocks.complete).toHaveBeenCalledWith("t-1", expect.anything());
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark First call done" }));
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("call for task t-2")).toBeTruthy();
  });

  it("calls logged from Tasks prompt for a meeting, then enrollment — like the contact page (B12)", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark First call done" }));
    fireEvent.click(await screen.findByRole("button", { name: "outcome positive" }));
    expect(await screen.findByRole("dialog", { name: "Schedule meeting" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Log call" })).toBeNull();
    cleanup();

    await renderPage();
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark First call done" }));
    fireEvent.click(await screen.findByRole("button", { name: "outcome nurture" }));
    expect(await screen.findByText("enroll call_not_connected")).toBeTruthy();
  });

  it("D2: the reply task's Sheet links to the reply; other tasks don't", async () => {
    mocks.rows = [
      task("t-9", "Lead replied on WhatsApp — respond today", { origin: "agent" }),
      task("t-1", "Send the deck"),
    ];
    await renderPage();
    fireEvent.click(screen.getByText("Lead replied on WhatsApp — respond today"));
    const sheet = await screen.findByRole("dialog", {
      name: "Lead replied on WhatsApp — respond today",
    });
    expect(within(sheet).getByRole("link", { name: "Read reply" }).getAttribute("href")).toMatch(
      /^\/contacts\/[^?]+\?tab=activity&activity=messages&reply=latest$/,
    );
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByText("Send the deck"));
    const other = await screen.findByRole("dialog", { name: "Send the deck" });
    expect(within(other).queryByRole("link", { name: "Read reply" })).toBeNull();
  });

  it("D4a: a reply task re-titled by its label still links to the reply", async () => {
    mocks.rows = [task("t-8", "Wants to talk — respond today", { origin: "agent" })];
    await renderPage();
    fireEvent.click(screen.getByText("Wants to talk — respond today"));
    const sheet = await screen.findByRole("dialog", { name: "Wants to talk — respond today" });
    expect(within(sheet).getByRole("link", { name: "Read reply" })).toBeTruthy();
  });

  it("row Sheet: details, reschedule (IST), reassign, cancel with a reason, log call", async () => {
    mocks.update.mockResolvedValue({});
    mocks.cancel.mockResolvedValue({});
    await renderPage();
    fireEvent.click(screen.getByText("Send the deck"));
    let sheet = await screen.findByRole("dialog", { name: "Send the deck" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Reschedule" }));
    fireEvent.change(within(sheet).getByLabelText("New date"), { target: { value: "2026-11-03" } });
    fireEvent.change(within(sheet).getByLabelText("Time (IST)"), { target: { value: "09:15" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save new time" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        id: "t-1",
        input: { dueAt: "2026-11-03T03:45:00.000Z" },
      }),
    );

    fireEvent.click(screen.getByText("Send the deck"));
    sheet = await screen.findByRole("dialog", { name: "Send the deck" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Reassign" }));
    fireEvent.keyDown(within(sheet).getByLabelText("New owner"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Ravi Rep" }));
    fireEvent.click(within(sheet).getAllByRole("button", { name: "Reassign" }).at(-1)!);
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ id: "t-1", input: { ownerId: "u-2" } }),
    );

    fireEvent.click(screen.getByText("Send the deck"));
    sheet = await screen.findByRole("dialog", { name: "Send the deck" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel task" }));
    fireEvent.change(within(sheet).getByLabelText("Reason (optional)"), {
      target: { value: "Duplicate" },
    });
    fireEvent.click(within(sheet).getAllByRole("button", { name: "Cancel task" }).at(-1)!);
    await waitFor(() =>
      expect(mocks.cancel).toHaveBeenCalledWith({ id: "t-1", reason: "Duplicate" }),
    );

    fireEvent.click(screen.getByText("Send the deck"));
    sheet = await screen.findByRole("dialog", { name: "Send the deck" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Log call" }));
    expect(await screen.findByText("call for task t-1")).toBeTruthy();
  });

  it("bulk Complete and Reassign confirm with the count and summarise failures", async () => {
    mocks.backendComplete.mockResolvedValue({});
    mocks.backendUpdate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Task is closed"));
    await renderPage();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all loaded rows" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    const confirm = await screen.findByRole("dialog", { name: "Complete tasks" });
    expect(confirm).toHaveTextContent("Mark 2 tasks as done?");
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Complete" }));
    });
    await waitFor(() => expect(mocks.backendComplete).toHaveBeenCalledTimes(2));
    expect(mocks.toast.success).toHaveBeenCalledWith("2 tasks completed");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all loaded rows" }));
    fireEvent.keyDown(screen.getByLabelText("Reassign to"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Ravi Rep" }));
    const reassign = await screen.findByRole("dialog", { name: "Reassign tasks" });
    expect(reassign).toHaveTextContent("Reassign 2 tasks to Ravi Rep?");
    await act(async () => {
      fireEvent.click(within(reassign).getByRole("button", { name: "Reassign" }));
    });
    await waitFor(() => expect(mocks.backendUpdate).toHaveBeenCalledTimes(2));
    expect(mocks.backendUpdate).toHaveBeenCalledWith("t-1", { ownerId: "u-2" });
    expect(mocks.toast.error).toHaveBeenCalledWith("1 reassigned, 1 failed: Task is closed");
  });
});
