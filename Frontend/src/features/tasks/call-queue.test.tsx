import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskListItem } from "@/types";
import { renderInRouter } from "@/test/render-in-router";

const mocks = vi.hoisted(() => ({
  rows: [] as TaskListItem[],
  logCall: vi.fn(),
  listParams: [] as unknown[],
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const task = (id: string, name: string, extra: Partial<TaskListItem> = {}): TaskListItem => ({
  id,
  leadId: `l-${id}`,
  ownerId: "u-1",
  ownerName: "Asha Owner",
  type: "call",
  title: "First call",
  dueAt: "2026-11-12T04:30:00.000Z",
  status: "open",
  done: false,
  origin: "manual",
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:00:00.000Z",
  contact: { id: `l-${id}`, name },
  company: null,
  isOverdue: false,
  ...extra,
});

vi.mock("sonner", () => ({ toast: mocks.toast }));
// A short Undo window keeps the tests real-time.
vi.mock("./queue-params", () => ({
  UNDO_MS: 60,
  callQueueParams: () => ({ ownerId: ["me"], replyTasks: "exclude", sort: "hotScore:desc" }),
}));
vi.mock("@/features/crm/activity-feed", () => ({
  ActivityFeed: ({ contactId }: { contactId: string }) => <p>activity of {contactId}</p>,
}));
vi.mock("@/features/work/log-call-flow", () => ({
  LogCallFlow: ({ open, taskId }: { open: boolean; taskId: string }) =>
    open ? <div role="dialog">full log call for {taskId}</div> : null,
}));
vi.mock("@/features/leads/scheduled-followups", () => ({ EnrollWorkflowDialog: () => null }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useSession: () => ({ currentUser: { id: "u-1" }, users: [] }),
  useTaskList: (params: unknown) => {
    mocks.listParams.push(params);
    return {
      data: { pages: [{ data: mocks.rows, nextCursor: null }] },
      isLoading: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    };
  },
  useTaskCount: () => ({ data: { count: mocks.rows.length } }),
  useLeadMutations: () => ({ logCall: mocks.logCall }),
  useContact: (id: string) => ({
    data: {
      id,
      firstName: id === "l-t1" ? "Ravi" : "Mira",
      lastName: "Kumar",
      companyText: "Acme",
      company: { id: "co-1", name: "Acme", domain: null },
      phone: "+919800000001",
      serviceInterest: "Hiring help",
      hotScore: 72,
      hotBand: "hot",
      hotReasons: [],
      agentStatus: "none",
      deals: [],
    },
    isLoading: false,
  }),
}));

import { CallQueuePage } from "./call-queue";

const renderQueue = () => renderInRouter(() => <CallQueuePage />);
const current = () => screen.getAllByRole("heading", { level: 2 })[0]!.textContent;

beforeEach(() => {
  window.localStorage.clear();
  mocks.rows = [task("t1", "Ravi Kumar"), task("t2", "Mira Kumar", { type: "follow_up" })];
  mocks.logCall.mockResolvedValue({ workflowTrigger: "call_not_connected" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CallQueuePage", () => {
  it("shows the hottest task first with tap-to-call, and No answer logs + completes it after the Undo window while the next one shows", async () => {
    await renderQueue();
    expect(current()).toBe("Ravi Kumar");
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\+919800000001/ })).toHaveAttribute(
      "href",
      "tel:+919800000001",
    );
    fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "Rang out" } });
    fireEvent.click(screen.getByRole("button", { name: /No answer/ }));
    // The next task is on screen at once; nothing is sent until Undo has passed.
    expect(current()).toBe("Mira Kumar");
    expect(mocks.logCall).not.toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalledWith(
      "No answer logged for Ravi Kumar",
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
    );
    // The backend applies the existing call rules (task completed, follow-up created).
    await waitFor(() =>
      expect(mocks.logCall).toHaveBeenCalledWith("l-t1", {
        connected: false,
        notConnectedReason: "no_answer",
        notes: "Rang out",
        taskId: "t1",
      }),
    );
    // The nurture prompt is offered, never applied silently.
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        "Ravi Kumar: choose a nurture workflow?",
        expect.anything(),
      ),
    );
  });

  it("Undo brings the task back and sends nothing", async () => {
    await renderQueue();
    fireEvent.click(screen.getByRole("button", { name: /Busy/ }));
    expect(current()).toBe("Mira Kumar");
    const [, options] = mocks.toast.success.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();
    await waitFor(() => expect(current()).toBe("Ravi Kumar"));
    await new Promise((r) => setTimeout(r, 120));
    expect(mocks.logCall).not.toHaveBeenCalled();
  });

  it("Call back at… sends a callback with the chosen time; Connected opens the full call dialog", async () => {
    await renderQueue();
    fireEvent.click(screen.getByRole("button", { name: /Call back at/ }));
    fireEvent.change(screen.getByLabelText("Call back at"), {
      target: { value: "2099-01-05T11:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save call back" }));
    await waitFor(() =>
      expect(mocks.logCall).toHaveBeenCalledWith("l-t1", {
        connected: true,
        connectedOutcome: "callback_requested",
        callbackDueAt: new Date("2099-01-05T11:30").toISOString(),
        notes: undefined,
        taskId: "t1",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Connected/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("full log call for t2");
  });

  it("keyboard outcomes work outside fields only; skip and pause resume after leaving", async () => {
    const view = await renderQueue();
    const noteBox = screen.getByLabelText("Note (optional)");
    noteBox.focus();
    fireEvent.keyDown(noteBox, { key: "2" });
    expect(current()).toBe("Ravi Kumar");
    fireEvent.keyDown(document.body, { key: "s" });
    expect(current()).toBe("Mira Kumar");
    fireEvent.keyDown(document.body, { key: "p" });
    expect(screen.getByText("Queue paused")).toBeInTheDocument();
    // Outcome keys do nothing while paused.
    fireEvent.keyDown(document.body, { key: "2" });
    view.unmount();

    // Coming back: still paused, the skip is remembered.
    await renderQueue();
    expect(screen.getByText("Queue paused")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Resume/ })[0]!);
    expect(current()).toBe("Mira Kumar");
    fireEvent.keyDown(document.body, { key: "3" });
    await waitFor(() =>
      expect(mocks.logCall).toHaveBeenCalledWith(
        "l-t2",
        expect.objectContaining({ notConnectedReason: "busy", taskId: "t2" }),
      ),
    );
    expect(mocks.logCall).toHaveBeenCalledTimes(1);
  });

  it("leaving the page sends an outcome still in its Undo window (nothing is lost)", async () => {
    const view = await renderQueue();
    fireEvent.click(screen.getByRole("button", { name: /Wrong number/ }));
    expect(mocks.logCall).not.toHaveBeenCalled();
    view.unmount();
    expect(mocks.logCall).toHaveBeenCalledWith(
      "l-t1",
      expect.objectContaining({ notConnectedReason: "wrong_number", taskId: "t1" }),
    );
  });
});
