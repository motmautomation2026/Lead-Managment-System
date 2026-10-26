import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProposalStatus } from "@/types";

const mocks = vi.hoisted(() => ({
  setStatus: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useSetProposalStatus: () => ({ mutateAsync: mocks.setStatus }),
}));

import { ProposalStatusDialog } from "./proposal-status-dialog";

const proposal = (status: ProposalStatus, allowedNextStatuses: ProposalStatus[]) => ({
  id: "p-1",
  title: "Fleet proposal",
  status,
  allowedNextStatuses,
});

const pick = (label: string, option: string) => {
  fireEvent.keyDown(screen.getByLabelText(label), { key: "Enter" });
  fireEvent.click(screen.getByRole("option", { name: option }));
};

afterEach(cleanup);

describe("ProposalStatusDialog (B4)", () => {
  it("offers only the row's allowed statuses", () => {
    render(
      <ProposalStatusDialog
        proposal={proposal("sent", ["accepted", "rejected"])}
        open
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText("New status"), { key: "Enter" });
    const options = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Accepted", "Rejected"]);
  });

  it("Rejected needs a loss reason, then sends it with the notes", async () => {
    mocks.setStatus.mockResolvedValue({});
    const onOpenChange = vi.fn();
    render(
      <ProposalStatusDialog
        proposal={proposal("sent", ["accepted", "rejected", "expired"])}
        open
        onOpenChange={onOpenChange}
      />,
    );
    pick("New status", "Rejected");
    fireEvent.click(screen.getByRole("button", { name: "Save status" }));
    expect(await screen.findByText("Pick a loss reason.")).toBeTruthy();
    expect(mocks.setStatus).not.toHaveBeenCalled();

    pick("Loss reason", "Price / Budget");
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Too costly" } });
    fireEvent.click(screen.getByRole("button", { name: "Save status" }));
    await waitFor(() =>
      expect(mocks.setStatus).toHaveBeenCalledWith({
        id: "p-1",
        status: "rejected",
        lossReason: "price_budget",
        lossNotes: "Too costly",
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Expired also needs a reason; Accepted does not", async () => {
    mocks.setStatus.mockResolvedValue({});
    render(
      <ProposalStatusDialog
        proposal={proposal("sent", ["accepted", "expired"])}
        open
        onOpenChange={vi.fn()}
      />,
    );
    pick("New status", "Expired");
    expect(screen.getByLabelText("Loss reason")).toBeTruthy();
    pick("New status", "Accepted");
    expect(screen.queryByLabelText("Loss reason")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save status" }));
    await waitFor(() =>
      expect(mocks.setStatus).toHaveBeenCalledWith({ id: "p-1", status: "accepted" }),
    );
  });

  it("a final status offers nothing; a backend error shows inline", async () => {
    const { unmount } = render(
      <ProposalStatusDialog proposal={proposal("accepted", [])} open onOpenChange={vi.fn()} />,
    );
    expect(screen.getByText(/Accepted is a final status/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save status" })).toBeNull();
    unmount();

    mocks.setStatus.mockRejectedValue(new Error("Proposal is already terminal."));
    render(
      <ProposalStatusDialog
        proposal={proposal("sent", ["accepted"])}
        open
        onOpenChange={vi.fn()}
      />,
    );
    pick("New status", "Accepted");
    fireEvent.click(screen.getByRole("button", { name: "Save status" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Proposal is already terminal.");
  });
});
