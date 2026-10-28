import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const AI_MANAGED = "This contact is managed by the AI agent. Stop the AI for this contact first.";
const mocks = vi.hoisted(() => ({ enrollLead: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useAutomations: () => ({
    workflows: [
      {
        id: "wf-1",
        name: "Nurture",
        status: "active",
        trigger: "interested_later",
        versions: [{ status: "published" }],
      },
    ],
    enrollLead: mocks.enrollLead,
  }),
}));

import { EnrollWorkflowDialog } from "./scheduled-followups";

afterEach(cleanup);

describe("EnrollWorkflowDialog", () => {
  it("E2: shows the server's 409 for a live AI contact inside the dialog", async () => {
    mocks.enrollLead.mockRejectedValue(new Error(AI_MANAGED));
    render(
      <EnrollWorkflowDialog
        leadId="lead-1"
        open
        onOpenChange={() => undefined}
        triggerFilter={"interested_later" as never}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(AI_MANAGED));
    expect(mocks.enrollLead).toHaveBeenCalledWith("lead-1", "wf-1", undefined);
  });
});
