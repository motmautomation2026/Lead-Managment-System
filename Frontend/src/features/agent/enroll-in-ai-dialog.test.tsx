import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enroll: vi.fn() }));

vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class extends Error {},
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  backend: { agent: { leads: { enroll: mocks.enroll } } },
}));

import { EnrollInAiDialog } from "./enroll-in-ai-dialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EnrollInAiDialog", () => {
  it("sends 250 ids as 100/100/50 and shows the summary in plain words", async () => {
    const skips = [
      "already_active",
      "not_eligible",
      "permanently_stopped",
      "no_contact",
      "not_found",
    ];
    mocks.enroll.mockImplementation(async (ids: string[]) => ({
      data: ids.map((leadId, i) => {
        const n = Number(leadId.slice(5));
        if (n >= 240) return { leadId, result: "failed", message: "x" };
        if (n >= 230) return { leadId, result: "skipped", reason: skips[i % skips.length] };
        return { leadId, result: "enrolled" };
      }),
    }));
    const onDone = vi.fn();
    const ids = Array.from({ length: 250 }, (_, i) => `lead-${i}`);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EnrollInAiDialog leadIds={ids} open onOpenChange={vi.fn()} onDone={onDone} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Enroll 250" }));
    await waitFor(() => expect(screen.getByText("230 leads enrolled.")).toBeTruthy());
    expect(mocks.enroll.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 50]);
    expect(onDone).toHaveBeenCalledOnce();
    for (const text of [
      "Already active: 2",
      "Not eligible: 2",
      "Permanently stopped: 2",
      "No email or phone: 2",
      "Not found: 2",
      "Failed: 10",
    ]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
  });
});
