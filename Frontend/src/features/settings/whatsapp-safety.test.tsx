import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppConnection } from "@/lib/backend-client";

const mocks = vi.hoisted(() => ({ isAdmin: false, update: vi.fn() }));

vi.mock("@/store", () => ({
  keys: { connection: (ws: string | null, kind: string) => ["connection", ws, kind] },
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
}));
vi.mock("@/lib/backend-client", () => ({
  backend: { connections: { whatsapp: { update: mocks.update } } },
}));

import { WhatsAppSafety } from "./whatsapp-safety";

const data = {
  enabled: true,
  maxNumbers: 5,
  todayCount: 7,
  sendWindow: { days: [1, 2, 3, 4, 5, 6], start: "09:30", end: "19:00" },
  numbers: [],
  newChatsToday: 3,
  failures24h: 1,
  stops24h: 0,
  safetyEvents: [
    {
      kind: "send_failed",
      detail: "rate-overlimit",
      at: "2026-10-28T04:00:00.000Z",
      numberLabel: "#2",
    },
  ],
  daily: [{ date: "2026-10-28", sent: 7, failed: 1, stops: 0 }],
} as unknown as WhatsAppConnection;

function renderSafety(over: Partial<WhatsAppConnection> = {}) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WhatsAppSafety workspaceId="ws-1" data={{ ...data, ...over }} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WhatsAppSafety (workspace level)", () => {
  it("shows the workspace monitoring to everyone, events named by number", () => {
    renderSafety();
    expect(screen.getByText("Sent today (all numbers)").nextSibling).toHaveTextContent("7");
    expect(screen.getByText("#2 · Send failed")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("2026-10-28");
  });

  it("is read-only for a salesperson", () => {
    mocks.isAdmin = false;
    renderSafety();
    expect(screen.getByText("Only admins can change these.")).toBeInTheDocument();
    expect(screen.getByText("Mon, Tue, Wed, Thu, Fri, Sat · 09:30–19:00 IST")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save WhatsApp settings" }),
    ).not.toBeInTheDocument();
  });

  it("lets an admin save the master switch, window and max numbers", async () => {
    mocks.isAdmin = true;
    mocks.update.mockResolvedValue({ ...data, maxNumbers: 3 });
    renderSafety();
    fireEvent.change(screen.getByLabelText("Max WhatsApp numbers"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Sun" }));
    fireEvent.click(screen.getByRole("button", { name: "Save WhatsApp settings" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    expect(mocks.update).toHaveBeenCalledWith({
      enabled: true,
      maxNumbers: 3,
      sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: "09:30", end: "19:00" },
    });
  });

  it("validates the window and the max", async () => {
    mocks.isAdmin = true;
    renderSafety();
    fireEvent.change(screen.getByLabelText("Max WhatsApp numbers"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Closes"), { target: { value: "09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save WhatsApp settings" }));
    expect(await screen.findByText("The window must start before it ends.")).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("the master switch off shows a red banner", () => {
    renderSafety({ enabled: false });
    expect(screen.getByRole("alert")).toHaveTextContent("no number sends");
  });
});
