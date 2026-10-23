import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Lead } from "@/types";

const mocks = vi.hoisted(() => ({ isAdmin: false, enroll: vi.fn() }));

const lead = (id: string, firstName: string, agentStatus: Lead["agentStatus"]): Lead =>
  ({
    id,
    firstName,
    lastName: "Rao",
    company: "Acme",
    source: "referral",
    pipelineStage: "connected_qualifying",
    lifecycleState: "active",
    automationMode: "manual",
    agentStatus,
    agentTouchCount: 0,
    responseState: "no_response",
    doNotContact: false,
    lastActivityAt: "2026-09-01T00:00:00.000Z",
    nextAction: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  }) as Lead;
const leads = [
  lead("l-1", "Asha", "active"),
  lead("l-2", "Ravi", "none"),
  lead("l-3", "Mira", "paused"),
];

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
  useSession: () => ({ users: [], userName: () => "Unassigned" }),
  useLeads: () => ({ leads, isLoading: false, error: null }),
  useAutomations: () => ({ scheduledActions: [] }),
  useEnrollLeads: () => ({ mutateAsync: mocks.enroll, isPending: false }),
}));

import { LeadsPage } from "./leads-page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.isAdmin = false;
});

describe("LeadsPage AI column and bulk enroll", () => {
  it("shows each lead's AI status", () => {
    render(<LeadsPage />);
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("salespeople get no checkboxes and no Enroll in AI", () => {
    render(<LeadsPage />);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Enroll in AI/ })).toBeNull();
  });

  it("admins select leads, then Enroll in AI enrolls the selected ones", async () => {
    mocks.isAdmin = true;
    mocks.enroll.mockResolvedValue([{ leadId: "l-2", result: "enrolled" }]);
    render(<LeadsPage />);
    expect(screen.queryByRole("button", { name: /Enroll in AI/ })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Ravi Rao" }));
    fireEvent.click(screen.getByRole("button", { name: "Enroll in AI (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Enroll 1" }));
    expect(await screen.findByText("1 lead enrolled.")).toBeTruthy();
    expect(mocks.enroll).toHaveBeenCalledWith(["l-2"]);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all shown leads" }));
    expect(screen.getByRole("button", { name: "Enroll in AI (3)" })).toBeTruthy();
  });
});
