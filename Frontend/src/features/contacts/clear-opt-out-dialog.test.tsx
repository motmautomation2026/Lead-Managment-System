import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ clear: vi.fn(), clearEmail: vi.fn() }));

vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useLeadMutations: () => ({
    clearWhatsAppOptOut: mocks.clear,
    clearEmailStatus: mocks.clearEmail,
  }),
}));

import { ClearOptOutDialog } from "./clear-opt-out-dialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ClearOptOutDialog", () => {
  it("needs a reason", async () => {
    render(<ClearOptOutDialog contactId="lead-1" open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear opt-out" }));
    expect(
      await screen.findByText("Say why the contact may be messaged again."),
    ).toBeInTheDocument();
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("clears with the trimmed reason and closes", async () => {
    mocks.clear.mockResolvedValue({ data: [] });
    const onOpenChange = vi.fn();
    render(<ClearOptOutDialog contactId="lead-1" open onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "  Asked to resume on a call " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear opt-out" }));
    await waitFor(() =>
      expect(mocks.clear).toHaveBeenCalledWith("lead-1", "Asked to resume on a call"),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("email channel (D3): its own wording; clears the email status with the reason", async () => {
    mocks.clearEmail.mockResolvedValue({ data: [] });
    const onOpenChange = vi.fn();
    render(
      <ClearOptOutDialog contactId="lead-1" channel="email" open onOpenChange={onOpenChange} />,
    );
    expect(screen.getByRole("dialog", { name: "Clear email status?" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: " New address confirmed " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear status" }));
    await waitFor(() =>
      expect(mocks.clearEmail).toHaveBeenCalledWith("lead-1", "New address confirmed"),
    );
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows a backend refusal inline", async () => {
    mocks.clear.mockRejectedValue(new Error("Only an admin can clear a WhatsApp opt-out."));
    render(<ClearOptOutDialog contactId="lead-1" open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Called" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear opt-out" }));
    expect(
      await screen.findByText("Only an admin can clear a WhatsApp opt-out."),
    ).toBeInTheDocument();
  });
});
