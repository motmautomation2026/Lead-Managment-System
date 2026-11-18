import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Workflow } from "@/types";

const mocks = vi.hoisted(() => ({
  BackendError: class extends Error {
    details: unknown;
    constructor(message: string, details: unknown) {
      super(message);
      this.details = details;
    }
  },
  update: vi.fn(),
  duplicate: vi.fn(),
  remove: vi.fn(),
  add: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("@/lib/backend-client", () => ({ BackendError: mocks.BackendError }));

const workflow = (id: string, name: string, extra: Partial<Workflow> = {}): Workflow => ({
  id,
  name,
  description: `${name} description`,
  trigger: "manual_enrollment",
  status: "active",
  currentVersion: 2,
  activeLeads: 4,
  failures: 0,
  updatedAt: "2026-10-20T10:00:00.000Z",
  versions: [
    { version: 2, status: "published", createdBy: "-", createdAt: "", steps: [] },
    { version: 3, status: "draft", createdBy: "-", createdAt: "", steps: [] },
  ],
  ...extra,
});

vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useAutomations: () => ({
    workflows: [
      workflow("w-1", "Nurture"),
      workflow("w-2", "Re-engage", { status: "paused", failures: 2 }),
    ],
    isLoading: false,
    error: null,
    isPending: false,
    updateWorkflow: mocks.update,
    duplicateWorkflow: mocks.duplicate,
    deleteWorkflow: mocks.remove,
    addWorkflow: mocks.add,
  }),
}));

import { WorkflowsPage } from "./workflows-page";

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, "hasPointerCapture", {
    value: vi.fn(() => false),
    writable: true,
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    value: vi.fn(),
    writable: true,
  });
});

async function renderPage() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/automations", component: WorkflowsPage }),
      createRoute({
        getParentRoute: () => root,
        path: "/automations/workflows/$workflowId",
        component: () => <div>builder</div>,
      }),
      createRoute({ getParentRoute: () => root, path: "/automations/runs", component: () => null }),
      createRoute({
        getParentRoute: () => root,
        path: "/automations/templates",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/automations"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Workflows" });
  return router;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkflowsPage (C6b)", () => {
  it("lists workflows in a table with trigger, status, versions, active runs; search filters", async () => {
    await renderPage();
    const table = screen.getByRole("table", { name: "Workflows" });
    expect(within(table).getByText("Nurture")).toBeTruthy();
    expect(within(table).getAllByText("Manual Enrollment").length).toBeGreaterThan(0);
    expect(within(table).getAllByText(/V2 published/i)).toHaveLength(2);
    expect(within(table).getAllByText(/V3 draft/i)).toHaveLength(2);
    expect(within(table).getByText("2 failed")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search workflows"), { target: { value: "re-en" } });
    expect(within(table).queryByText("Nurture")).toBeNull();
    expect(within(table).getByText("Re-engage")).toBeTruthy();
  });

  it("toggles active/paused and duplicates, as before", async () => {
    mocks.update.mockResolvedValue({});
    mocks.duplicate.mockResolvedValue({});
    await renderPage();
    fireEvent.click(screen.getByRole("switch", { name: "Nurture active" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("w-1", { status: "paused" }));
    expect(mocks.toast.success).toHaveBeenCalledWith("Workflow paused");
    fireEvent.click(screen.getByRole("switch", { name: "Re-engage active" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("w-2", { status: "active" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Nurture" }));
    await waitFor(() => expect(mocks.duplicate).toHaveBeenCalledWith("w-1"));
  });

  it("delete asks once; enrollment history asks again and force-deletes", async () => {
    mocks.remove
      .mockRejectedValueOnce(
        new mocks.BackendError("Has history", { reason: "has_enrollment_history" }),
      )
      .mockResolvedValueOnce(undefined);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Delete Nurture" }));
    let confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText('Delete "Nurture"?')).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("w-1"));
    confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText('Force delete "Nurture"?')).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Force delete" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("w-1", true));
  });

  it("New workflow creates a draft; a row opens the builder", async () => {
    mocks.add.mockResolvedValue({});
    const router = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getAllByRole("textbox")[0]!, { target: { value: "Fresh" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create draft" }));
    await waitFor(() =>
      expect(mocks.add).toHaveBeenCalledWith({
        name: "Fresh",
        description: undefined,
        trigger: "manual_enrollment",
      }),
    );
    fireEvent.click(screen.getByText("Re-engage"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/automations/workflows/w-2"));
  });
});
