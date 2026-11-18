import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), change: vi.fn() }));

vi.mock("@/store", () => ({
  keys: {
    connection: (ws: string | null, kind: string) => ["connection", ws, kind],
    contact: (ws: string | null, id: string) => ["contact", ws, id],
    contactTimeline: (ws: string | null, id: string) => ["contactTimeline", ws, id],
  },
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
}));
vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/lib/backend-client", () => ({
  backend: {
    connections: { whatsapp: { get: mocks.get } },
    contacts: { changeWhatsAppNumber: mocks.change },
  },
}));

import { MoveWhatsAppNumberDialog } from "./move-whatsapp-number-dialog";

function renderDialog(onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MoveWhatsAppNumberDialog
        contactId="lead-1"
        currentNumberId="n-1"
        open
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MoveWhatsAppNumberDialog (E4a rule 6)", () => {
  it("needs a number and a reason", async () => {
    mocks.get.mockResolvedValue({ numbers: [{ id: "n-1", label: "#1", status: "connected" }] });
    renderDialog();
    expect(
      await screen.findByText("This workspace has no other WhatsApp number."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(await screen.findByText("Pick a number.")).toBeInTheDocument();
    expect(screen.getByText("Say why the contact moves.")).toBeInTheDocument();
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    mocks.get.mockResolvedValue({ numbers: [] });
    mocks.change.mockRejectedValue(new Error("A reason is required."));
    renderDialog();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Rep changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(screen.getByText("Pick a number.")).toBeInTheDocument());
  });
});
