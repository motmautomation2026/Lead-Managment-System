import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppConnection } from "@/lib/backend-client";

const mocks = vi.hoisted(() => ({ isAdmin: false, update: vi.fn(), resume: vi.fn() }));

vi.mock("@/store", () => ({
  keys: { connection: (ws: string | null, kind: string) => ["connection", ws, kind] },
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
}));
vi.mock("@/lib/backend-client", () => ({
  backend: { connections: { whatsapp: { update: mocks.update, resume: mocks.resume } } },
}));

import { WhatsAppSafety } from "./whatsapp-safety";

const data = {
  enabled: true,
  dailyCap: 200,
  minDelaySeconds: 45,
  maxDelaySeconds: 120,
  todayCount: 7,
  pairedAt: "2026-10-27T05:00:00.000Z",
  warmupDay: 2,
  effectiveDailyCap: 20,
  maxNewChatsPerDay: 20,
  sendWindow: { days: [1, 2, 3, 4, 5, 6], start: "09:30", end: "19:00" },
  pause: null,
  newChatsToday: 3,
  failures24h: 1,
  stops24h: 0,
  safetyEvents: [{ kind: "send_failed", detail: "rate-overlimit", at: "2026-10-28T04:00:00.000Z" }],
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

describe("WhatsAppSafety", () => {
  it("shows the monitoring numbers to everyone, with the warm-up day", () => {
    renderSafety();
    expect(screen.getByText("7 / 20 (warm-up day 2)")).toBeInTheDocument();
    expect(screen.getByText("3 / 20")).toBeInTheDocument();
    expect(screen.getByText("Send failed")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("2026-10-28");
  });

  it("is read-only for a salesperson", () => {
    mocks.isAdmin = false;
    renderSafety();
    expect(screen.getByText("Only admins can change these.")).toBeInTheDocument();
    expect(screen.getByText("45–120 s")).toBeInTheDocument();
    expect(screen.getByText("Mon, Tue, Wed, Thu, Fri, Sat · 09:30–19:00 IST")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save safety settings" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Min spacing (seconds)")).not.toBeInTheDocument();
  });

  it("lets an admin save the settings", async () => {
    mocks.isAdmin = true;
    mocks.update.mockResolvedValue({ ...data, minDelaySeconds: 60 });
    renderSafety();
    fireEvent.change(screen.getByLabelText("Min spacing (seconds)"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Sun" }));
    fireEvent.click(screen.getByRole("button", { name: "Save safety settings" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    expect(mocks.update).toHaveBeenCalledWith({
      enabled: true,
      dailyCap: 200,
      minDelaySeconds: 60,
      maxDelaySeconds: 120,
      maxNewChatsPerDay: 20,
      sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: "09:30", end: "19:00" },
    });
  });

  it("validates min ≤ max spacing and window start < end", async () => {
    mocks.isAdmin = true;
    renderSafety();
    fireEvent.change(screen.getByLabelText("Min spacing (seconds)"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText("Closes"), { target: { value: "09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save safety settings" }));
    expect(
      await screen.findByText("The minimum can't be more than the maximum."),
    ).toBeInTheDocument();
    expect(screen.getByText("The window must start before it ends.")).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("shows a red paused banner; an admin resumes after confirming", async () => {
    mocks.isAdmin = true;
    mocks.resume.mockResolvedValue({ ...data, enabled: true, pause: null });
    renderSafety({
      enabled: false,
      pause: {
        reason: "3 contacts asked us to stop in 24 hours.",
        at: "2026-10-28T05:00:00.000Z",
        byName: null,
      },
    });
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("WhatsApp sending is paused");
    expect(banner).toHaveTextContent("3 contacts asked us to stop in 24 hours.");
    expect(banner).toHaveTextContent("automatically");
    fireEvent.click(screen.getByRole("button", { name: "Resume sending" }));
    expect(mocks.resume).not.toHaveBeenCalled();
    const confirm = screen.getAllByRole("button", { name: "Resume sending" }).at(-1)!;
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
  });

  it("a salesperson sees the paused banner without the Resume button", () => {
    mocks.isAdmin = false;
    renderSafety({
      enabled: false,
      pause: { reason: "Paused by Ada.", at: "2026-10-28T05:00:00.000Z", byName: "Ada" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("by Ada");
    expect(screen.queryByRole("button", { name: "Resume sending" })).not.toBeInTheDocument();
  });
});
