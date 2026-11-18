import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppConnection } from "@/lib/backend-client";

const mocks = vi.hoisted(() => ({ isAdmin: false, update: vi.fn(), safetyEvents: vi.fn() }));

vi.mock("@/store", () => ({
  keys: {
    connection: (ws: string | null, kind: string) => ["connection", ws, kind],
    safetyEvents: (ws: string, kind: string) => ["safety-events", ws, kind],
  },
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
}));
vi.mock("@/store/server-hooks", () => ({
  useCursorList: (
    queryKey: readonly unknown[],
    fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<unknown>,
  ) =>
    useInfiniteQuery({
      queryKey,
      queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal) as never,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    }),
}));
vi.mock("@/lib/backend-client", () => ({
  backend: {
    connections: { whatsapp: { update: mocks.update, safetyEvents: mocks.safetyEvents } },
  },
}));

import { renderInRouter } from "@/test/render-in-router";
import { WhatsAppMonitoring, WhatsAppSafety } from "./whatsapp-safety";

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
  pendingCount: 2,
  invalidPhoneCount: 0,
  inboundReview: [],
} as unknown as WhatsAppConnection;

const renderSafety = (over: Partial<WhatsAppConnection> = {}) =>
  renderInRouter(() => <WhatsAppSafety workspaceId="ws-1" data={{ ...data, ...over }} />);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WhatsAppSafety (workspace level)", () => {
  it("Monitoring shows the workspace counts to everyone, the event history named by number, 14 days", async () => {
    mocks.safetyEvents.mockResolvedValue({
      data: [{ id: "e-1", ...data.safetyEvents[0]! }],
      nextCursor: null,
    });
    await renderInRouter(() => <WhatsAppMonitoring workspaceId="ws-1" data={data} />);
    expect(screen.getByText("Sent today (all numbers)").nextSibling).toHaveTextContent("7");
    expect(await screen.findByText("#2 · Send failed")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("2026-10-28");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("is read-only for a salesperson", async () => {
    mocks.isAdmin = false;
    await renderSafety();
    expect(screen.getByText("Only admins can change these.")).toBeInTheDocument();
    expect(screen.getByText("Mon, Tue, Wed, Thu, Fri, Sat · 09:30–19:00 IST")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save WhatsApp settings" }),
    ).not.toBeInTheDocument();
  });

  it("lets an admin save the master switch, window and max numbers", async () => {
    mocks.isAdmin = true;
    mocks.update.mockResolvedValue({ ...data, maxNumbers: 3 });
    await renderSafety();
    expect(screen.queryByRole("button", { name: "Save WhatsApp settings" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Max WhatsApp numbers"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Sun" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save WhatsApp settings" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    expect(mocks.update).toHaveBeenCalledWith({
      enabled: true,
      maxNumbers: 3,
      sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: "09:30", end: "19:00" },
    });
  });

  it("validates the window and the max", async () => {
    mocks.isAdmin = true;
    await renderSafety();
    fireEvent.change(screen.getByLabelText("Max WhatsApp numbers"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Closes"), { target: { value: "09:00" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save WhatsApp settings" }));
    expect(await screen.findByText("The window must start before it ends.")).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("the master switch off shows a red banner", async () => {
    await renderSafety({ enabled: false });
    expect(screen.getByRole("alert")).toHaveTextContent("no number sends");
  });
});
