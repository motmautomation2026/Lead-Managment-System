import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberships: vi.fn(),
  setMembership: vi.fn(),
  create: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/backend-client", () => ({
  backend: {
    superAdmin: { memberships: mocks.memberships, setMembership: mocks.setMembership },
    workspaces: { create: mocks.create },
  },
}));
vi.mock("@/store", async () => {
  const { keys } = await import("@/store/query");
  return {
    keys,
    messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  };
});

import { SuperAdminPanel } from "./super-admin-panel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const workspaces = [
  { id: "ws-motm", name: "MOTM" },
  { id: "ws-b", name: "Test B" },
];

function renderPanel() {
  mocks.memberships.mockImplementation(async ({ cursor }: { cursor?: string }) =>
    cursor
      ? {
          workspaces,
          data: [{ id: "u-3", name: "Third", email: "c@x.in", isSuperAdmin: false, roles: {} }],
          nextCursor: null,
        }
      : {
          workspaces,
          data: [
            {
              id: "u-1",
              name: "Demo Admin",
              email: "a@x.in",
              isSuperAdmin: true,
              roles: { "ws-motm": "admin" },
            },
            {
              id: "u-2",
              name: "Naitik",
              email: "n@x.in",
              isSuperAdmin: false,
              roles: { "ws-motm": "salesperson" },
            },
          ],
          nextCursor: "next",
        },
  );
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SuperAdminPanel />
    </QueryClientProvider>,
  );
}

describe("SuperAdminPanel (E4b rule 10)", () => {
  it("shows every workspace × user with roles, pages on, and changes a membership", async () => {
    mocks.setMembership.mockResolvedValue({ data: [] });
    renderPanel();
    expect(((await screen.findByLabelText("Naitik in MOTM")) as HTMLSelectElement).value).toBe(
      "salesperson",
    );
    expect((screen.getByLabelText("Naitik in Test B") as HTMLSelectElement).value).toBe("");
    expect(screen.getByText("super-admin")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Demo Admin in Test B"), { target: { value: "admin" } });
    await waitFor(() =>
      expect(mocks.setMembership).toHaveBeenCalledWith({
        workspaceId: "ws-b",
        userId: "u-1",
        role: "admin",
      }),
    );
    fireEvent.change(screen.getByLabelText("Naitik in MOTM"), { target: { value: "" } });
    await waitFor(() =>
      expect(mocks.setMembership).toHaveBeenCalledWith({
        workspaceId: "ws-motm",
        userId: "u-2",
        role: null,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Third")).toBeTruthy();
  });

  it("creates a workspace (the creator becomes its admin)", async () => {
    mocks.create.mockResolvedValue({ id: "ws-c", name: "Test C", role: "admin" });
    renderPanel();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Test C" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("Test C"));
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith(
        'Workspace "Test C" created. You are its admin.',
      ),
    );
  });
});
