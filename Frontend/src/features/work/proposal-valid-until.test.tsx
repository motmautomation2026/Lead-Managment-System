import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useUpdateProposal: () => ({ mutateAsync: mocks.update, isPending: false }),
}));

import { ProposalValidUntil } from "./proposal-valid-until";

const proposal = { id: "p-1", validUntil: "2026-12-18" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProposalValidUntil (LL-3b rule 5)", () => {
  it("owner / admin: changes the date of a sent proposal through PATCH", async () => {
    mocks.update.mockResolvedValue({});
    render(<ProposalValidUntil proposal={proposal} canEdit />);
    expect(screen.getByText("2026-12-18")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Valid until"), { target: { value: "2027-01-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ id: "p-1", input: { validUntil: "2027-01-15" } }),
    );
    await waitFor(() => expect(screen.queryByLabelText("Valid until")).toBeNull());
    expect(mocks.toast.success).toHaveBeenCalled();
  });

  it("anyone else sees the date without a Change button", () => {
    render(<ProposalValidUntil proposal={proposal} canEdit={false} />);
    expect(screen.getByText("2026-12-18")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("a refused change (403) shows the error and keeps the editor open", async () => {
    mocks.update.mockRejectedValue(
      new Error("Only the owner or an admin can change the proposal's valid-until date."),
    );
    render(<ProposalValidUntil proposal={proposal} canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "Only the owner or an admin can change the proposal's valid-until date.",
      ),
    );
    expect(screen.getByLabelText("Valid until")).toBeTruthy();
  });
});
