import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeadSummaryCard as Card } from "@/types";

const mocks = vi.hoisted(() => ({
  data: null as unknown,
  mutate: vi.fn(),
}));

vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useLeadSummary: () => ({ data: mocks.data, isPending: false, isError: false }),
  useRefreshLeadSummary: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { LeadSummaryCard } from "./lead-summary-card";

const SUMMARY_COLLAPSED_KEY = "motmflow.leadSummaryCollapsed";

const CARD: Card = {
  quickFacts: {
    requirement: "Export sales calling",
    lastCall: { at: "2026-11-20T06:00:00Z", connected: true, outcome: "interested" },
    lastMessage: null,
    lastReply: { at: "2026-11-21T06:00:00Z", channel: "whatsapp", label: "question" },
    nextStep: null,
  },
  ai: {
    summary: {
      requirement: "Wants export sales calling",
      soFar: ["20 Nov: call connected, asked for pricing"],
      status: "Active, warm, AI handed off",
      nextStep: "No next step",
    },
    generatedAt: "2026-11-23T05:00:00Z",
    status: "ready",
    pending: false,
  },
  canRefresh: true,
  refreshAvailableAt: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("LeadSummaryCard (SUM-1)", () => {
  it("shows the AI summary bullets, quick facts and Updated time", () => {
    mocks.data = CARD;
    render(<LeadSummaryCard contactId="lead-1" />);
    expect(screen.getByText("Wants export sales calling")).toBeInTheDocument();
    expect(screen.getByText("20 Nov: call connected, asked for pricing")).toBeInTheDocument();
    expect(screen.getByText("Export sales calling")).toBeInTheDocument();
    expect(screen.getAllByText("No next step").length).toBeGreaterThan(0);
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });

  it("Refresh queues a summary; hidden for people who may not refresh", () => {
    mocks.data = CARD;
    render(<LeadSummaryCard contactId="lead-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    cleanup();
    mocks.data = { ...CARD, canRefresh: false };
    render(<LeadSummaryCard contactId="lead-1" />);
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
  });

  it("disables Refresh within 5 minutes of the last one", () => {
    mocks.data = { ...CARD, refreshAvailableAt: new Date(Date.now() + 120_000).toISOString() };
    render(<LeadSummaryCard contactId="lead-1" />);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  });

  it("remembers the collapsed state", () => {
    mocks.data = CARD;
    render(<LeadSummaryCard contactId="lead-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Lead summary" }));
    expect(screen.queryByText("Wants export sales calling")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(SUMMARY_COLLAPSED_KEY)).toBe("1");
    cleanup();
    render(<LeadSummaryCard contactId="lead-1" />);
    expect(screen.getByRole("button", { name: "Lead summary" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("says when the daily cap paused the AI summary; quick facts stay", () => {
    mocks.data = {
      ...CARD,
      ai: { summary: null, generatedAt: null, status: "paused_cap", pending: false },
    };
    render(<LeadSummaryCard contactId="lead-1" />);
    expect(screen.getByText("AI summary paused for today.")).toBeInTheDocument();
    expect(screen.getByText("Export sales calling")).toBeInTheDocument();
  });
});
