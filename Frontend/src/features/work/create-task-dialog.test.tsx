import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateTaskOptions } from "@/app/add-lead-context";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useCreateTask: () => ({ mutateAsync: mocks.create }),
  useSession: () => ({
    users: [
      { id: "u-1", name: "Asha Owner", active: true },
      { id: "u-2", name: "Ravi Rep", active: true },
    ],
  }),
  useContact: (id: string) => ({ data: id ? { id, ownerId: "u-1" } : undefined }),
  useContactSearch: () => ({
    data: { data: [{ id: "l-1", name: "Ravi Kumar", email: null, company: null }] },
    isFetching: false,
    isError: false,
  }),
}));

import { CreateTaskDialog } from "./create-task-dialog";

function renderDialog(options: CreateTaskOptions = {}) {
  const onOpenChange = vi.fn();
  render(<CreateTaskDialog open onOpenChange={onOpenChange} options={options} />);
  return { onOpenChange };
}

afterEach(cleanup);

describe("CreateTaskDialog", () => {
  it("needs a contact and a title; sends the IST due time and the contact's owner", async () => {
    mocks.create.mockResolvedValue({ id: "t-1" });
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Choose the contact this task is for.")).toBeTruthy();
    expect(screen.getByText("Give the task a title.")).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Contact" }));
    fireEvent.change(screen.getByLabelText("Search contacts"), { target: { value: "ravi" } });
    fireEvent.click(await screen.findByText("Ravi Kumar"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Send the deck" } });
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-11-02" } });
    fireEvent.change(screen.getByLabelText("Time (IST)"), { target: { value: "15:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        leadId: "l-1",
        type: "follow_up",
        title: "Send the deck",
        // 15:30 IST = 10:00 UTC.
        dueAt: "2026-11-02T10:00:00.000Z",
        ownerId: "u-1",
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.toast.success).toHaveBeenCalledWith("Task created");
  });

  it("from a record: the contact is fixed and another owner can be picked", async () => {
    mocks.create.mockResolvedValue({ id: "t-2" });
    renderDialog({ contact: { id: "c-9", name: "Asha Rao" } });
    expect(screen.queryByRole("button", { name: "Contact" })).toBeNull();
    expect(screen.getByText("Asha Rao")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Call back" } });
    fireEvent.keyDown(screen.getByLabelText("Owner"), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "Ravi Rep" }));
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ leadId: "c-9", title: "Call back", ownerId: "u-2" }),
      ),
    );
  });

  it("shows a backend error inline and stays open", async () => {
    mocks.create.mockRejectedValue(new Error("Lead not found"));
    const { onOpenChange } = renderDialog({ contact: { id: "c-9", name: "Asha Rao" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Call back" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Lead not found");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
