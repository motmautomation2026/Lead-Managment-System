import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ update: vi.fn(), move: vi.fn(), toast: { success: vi.fn() } }));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useUpdateDeal: () => ({ mutateAsync: mocks.update }),
  useMoveDealStage: () => ({ mutateAsync: mocks.move }),
}));

import { CloseDealDialog, type CloseMode } from "./close-deal-dialog";

const deal = {
  id: "d-1",
  name: "Acme rollout",
  stage: "negotiation" as const,
  amount: 500000,
  expectedCloseDate: "2026-11-30",
};

beforeAll(() => {
  // Radix Select calls these; jsdom lacks them.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(mode: CloseMode, d: typeof deal | Record<string, unknown> = deal) {
  const onDone = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <CloseDealDialog
      deal={d as typeof deal}
      mode={mode}
      open
      onOpenChange={onOpenChange}
      onDone={onDone}
    />,
  );
  return { onDone, onOpenChange };
}

function pick(trigger: HTMLElement, option: string) {
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("CloseDealDialog", () => {
  it("won: an edited amount is PATCHed first, then the stage moves to won", async () => {
    mocks.update.mockResolvedValue({});
    mocks.move.mockResolvedValue({});
    const { onDone } = renderDialog("won");
    expect(screen.getByText(/the contact is also marked Won/)).toBeTruthy();
    expect(screen.getByLabelText("Amount (INR)")).toHaveValue("500000");
    fireEvent.change(screen.getByLabelText("Amount (INR)"), { target: { value: "650000" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark won" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mocks.update).toHaveBeenCalledWith({ id: "d-1", input: { amount: 650000 } });
    expect(mocks.move).toHaveBeenCalledWith({ id: "d-1", stage: "won" });
    expect(mocks.update.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.move.mock.invocationCallOrder[0]!,
    );
  });

  it("won without changes skips the PATCH", async () => {
    mocks.move.mockResolvedValue({});
    const { onDone } = renderDialog("won");
    fireEvent.click(screen.getByRole("button", { name: "Mark won" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("lost: a reason is required; the contact choice goes in the same request", async () => {
    mocks.move.mockResolvedValue({});
    const { onDone } = renderDialog("lost");
    fireEvent.click(screen.getByRole("button", { name: "Mark lost" }));
    expect(await screen.findByText("Pick a loss reason.")).toBeTruthy();
    expect(mocks.move).not.toHaveBeenCalled();

    expect(screen.getByRole("radio", { name: /Keep active/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Move to long-term nurture/ })).toBeTruthy();
    pick(screen.getByLabelText("Loss reason"), "Price / Budget");
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Too pricey" } });
    fireEvent.click(screen.getByRole("radio", { name: /Mark contact lost/ }));
    fireEvent.click(screen.getByRole("button", { name: "Mark lost" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mocks.move).toHaveBeenCalledWith({
      id: "d-1",
      stage: "lost",
      lossReason: "price_budget",
      lossNotes: "Too pricey",
      contactAction: "lost",
    });
  });

  it("reopen: picks an open stage", async () => {
    mocks.move.mockResolvedValue({});
    const { onDone } = renderDialog("reopen", { ...deal, stage: "lost" });
    pick(screen.getByLabelText("Reopen at stage"), "Negotiation");
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mocks.move).toHaveBeenCalledWith({ id: "d-1", stage: "negotiation" });
  });

  it("shows backend errors inline and stays open", async () => {
    mocks.move.mockRejectedValue(new Error("The deal is already in this stage."));
    const { onDone, onOpenChange } = renderDialog("reopen", { ...deal, stage: "won" });
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The deal is already in this stage.",
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
