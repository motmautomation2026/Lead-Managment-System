import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logCall: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useLeadMutations: () => ({ logCall: mocks.logCall, isPending: false }),
  useContact: (id: string) => ({ data: { id, firstName: "Asha", lastName: "Rao" } }),
}));

import { LogCallDialog } from "./log-call-dialog";

beforeEach(() => {
  // 14:00 IST on Monday 26 Oct 2026: today's 10:00 has passed.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T08:30:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function renderCallback() {
  render(<LogCallDialog leadId="l-1" open onOpenChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Connected" }));
  fireEvent.click(screen.getByRole("button", { name: "Callback Requested" }));
}

describe("LogCallDialog callback (B13)", () => {
  it("defaults to the next working day 10:00 IST and has a time picker", () => {
    renderCallback();
    expect(screen.getByLabelText("Callback date")).toHaveValue("2026-10-27");
    expect(screen.getByLabelText("Time (IST)")).toHaveValue("10:00");
  });

  it("a callback later today is allowed and sent with its IST time", async () => {
    mocks.logCall.mockResolvedValue({});
    renderCallback();
    fireEvent.change(screen.getByLabelText("Callback date"), { target: { value: "2026-10-26" } });
    fireEvent.change(screen.getByLabelText("Time (IST)"), { target: { value: "17:30" } });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save call" }));
    });
    await waitFor(() =>
      expect(mocks.logCall).toHaveBeenCalledWith(
        "l-1",
        expect.objectContaining({
          connected: true,
          connectedOutcome: "callback_requested",
          callbackDueAt: "2026-10-26T12:00:00.000Z",
        }),
      ),
    );
  });

  it("a time already past shows the error inline and nothing is sent", () => {
    renderCallback();
    fireEvent.change(screen.getByLabelText("Callback date"), { target: { value: "2026-10-26" } });
    fireEvent.change(screen.getByLabelText("Time (IST)"), { target: { value: "11:00" } });
    expect(screen.getByRole("alert").textContent).toBe("The callback must be in the future.");
    expect(screen.getByRole("button", { name: "Save call" })).toBeDisabled();
    expect(mocks.logCall).not.toHaveBeenCalled();
  });
});
