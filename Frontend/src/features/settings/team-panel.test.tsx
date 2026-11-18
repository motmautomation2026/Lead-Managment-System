import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const members = [
  {
    userId: "u-admin",
    name: "Asha Admin",
    email: "asha@motm.test",
    active: true,
    role: "admin",
    since: "2026-11-01T00:00:00Z",
  },
  {
    userId: "u-rep",
    name: "Naitik",
    email: "naitik@motm.test",
    active: true,
    role: "salesperson",
    since: "2026-11-02T00:00:00Z",
  },
];
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  setRole: vi.fn(),
  remove: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/backend-client", () => ({
  backend: {
    team: { list: mocks.list, add: mocks.add, setRole: mocks.setRole, remove: mocks.remove },
  },
}));
vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({
    currentWorkspace: { id: "ws-1", name: "MOTM" },
    currentWorkspaceId: "ws-1",
  }),
}));
vi.mock("@/store", async () => {
  const { keys } = await import("@/store/query");
  return {
    keys,
    messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  };
});

import { renderInRouter } from "@/test/render-in-router";
import { TeamPanel } from "./team-panel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPanel() {
  mocks.list.mockResolvedValue({ data: members, nextCursor: null });
  return renderInRouter(() => <TeamPanel />);
}

describe("TeamPanel (E4b rule 9)", () => {
  it("lists members with their role here; adds an existing user by email", async () => {
    mocks.add.mockResolvedValue({ data: members });
    await renderPanel();
    expect(await screen.findByText("Naitik")).toBeTruthy();
    expect((screen.getByLabelText("Role of Asha Admin") as HTMLSelectElement).value).toBe("admin");
    fireEvent.change(screen.getByLabelText("Add an existing user by email"), {
      target: { value: " new@motm.test " },
    });
    fireEvent.change(screen.getByLabelText("Role in this workspace"), {
      target: { value: "admin" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    await waitFor(() =>
      expect(mocks.add).toHaveBeenCalledWith({ email: "new@motm.test", role: "admin" }),
    );
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Member added."));
  });

  it("changes a role", async () => {
    mocks.setRole.mockResolvedValue({ data: members });
    await renderPanel();
    fireEvent.change(await screen.findByLabelText("Role of Naitik"), {
      target: { value: "admin" },
    });
    await waitFor(() => expect(mocks.setRole).toHaveBeenCalledWith("u-rep", "admin"));
  });

  it("a blocked remove shows the backend's reason (owned work, last admin)", async () => {
    mocks.remove.mockRejectedValue(
      new Error(
        "This user still owns 3 active contact(s), 0 open deal(s) and 1 open task(s) in this workspace. Reassign them first.",
      ),
    );
    await renderPanel();
    const row = (await screen.findByText("Naitik")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Naitik?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("u-rep"));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        expect.stringContaining("still owns 3 active contact(s)"),
      ),
    );
  });

  it("UX-1: members are paged (Load more) and searched on the server", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: [members[0]], nextCursor: "c-2" })
      .mockResolvedValueOnce({ data: [members[1]], nextCursor: null })
      .mockResolvedValue({ data: [members[1]], nextCursor: null });
    await renderInRouter(() => <TeamPanel />);
    expect(await screen.findByText("Asha Admin")).toBeInTheDocument();
    expect(screen.queryByText("Naitik")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Naitik")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenLastCalledWith({ cursor: "c-2", q: undefined }, expect.anything());
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search members"), { target: { value: "nai" } });
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        { cursor: undefined, q: "nai" },
        expect.anything(),
      ),
    );
  });
});
