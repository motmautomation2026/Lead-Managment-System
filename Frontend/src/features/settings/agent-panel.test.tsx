import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const settings = {
  mode: "off",
  sendDays: [1, 2, 3, 4, 5, 6],
  sendWindowStart: "09:30",
  sendWindowEnd: "19:00",
  minGapHours: 48,
  maxTouches7d: 2,
  maxTouchesTotal: 8,
  emailMaxWords: 250,
  whatsappMaxWords: 80,
  wakeMinDays: 1,
  wakeMaxDays: 30,
  nurtureLongTerm: false,
  monthlyBudgetUsd: 100,
  maxDecisionsPerDay: 50,
  decisionModel: null,
  groundingModel: null,
  emailOptOutText: "Reply stop.",
  whatsappOptOutText: "Reply STOP to opt out.",
  repQuietHours: 24,
  autoEnrollNewLeads: false,
  companyDisplayName: null,
  currentPlaybookVersion: null,
  updatedBy: "admin-1",
  updatedAt: "2026-10-23T05:30:00.000Z",
  activeLeadCount: 12,
};

const mocks = vi.hoisted(() => ({
  isAdmin: false,
  update: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  settingsQuery: vi.fn(),
}));

vi.mock("@/store", () => {
  const mutation = (fn: ReturnType<typeof vi.fn>) => ({
    mutate: fn,
    isPending: false,
    isError: false,
  });
  return {
    messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
    useIsAdmin: () => mocks.isAdmin,
    useSession: () => ({ userName: () => "Ada Admin" }),
    useAgentSettings: () => mocks.settingsQuery(),
    useUpdateAgentSettings: () => mutation(mocks.update),
    useAgentPlaybooks: () => ({ data: { currentVersion: null, data: [] }, isError: false }),
    useSavePlaybook: () => mutation(mocks.save),
    useRestorePlaybook: () => mutation(mocks.restore),
  };
});

import { AgentPanel } from "./agent-panel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentPanel", () => {
  it("is hidden from salespeople and never loads the settings", () => {
    mocks.isAdmin = false;
    const view = render(<AgentPanel />);
    expect(view.container).toBeEmptyDOMElement();
    expect(mocks.settingsQuery).not.toHaveBeenCalled();
  });

  it("asks for confirmation before switching Off → Shadow, then saves the mode", () => {
    mocks.isAdmin = true;
    mocks.settingsQuery.mockReturnValue({ data: settings, isError: false });
    render(<AgentPanel />);
    expect(screen.getByRole("button", { name: "Live (coming later)" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Shadow" }));
    expect(screen.getByText(/Nothing is sent to leads in Shadow mode/)).toBeInTheDocument();
    expect(
      screen.getByText(/12 leads are enrolled in the AI and will be reviewed now/),
    ).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Turn on Shadow" }));
    expect(mocks.update).toHaveBeenCalledWith({ mode: "shadow" }, expect.any(Object));
  });

  it("saves the limits form with numbers and blank models as null", () => {
    mocks.isAdmin = true;
    mocks.settingsQuery.mockReturnValue({ data: settings, isError: false });
    render(<AgentPanel />);
    fireEvent.change(screen.getByLabelText("Wait after a rep's call or note (hours)"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Sun" }));
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        repQuietHours: 12,
        minGapHours: 48,
        sendDays: [1, 2, 3, 4, 5, 6, 7],
        decisionModel: null,
        companyDisplayName: null,
      }),
      expect.any(Object),
    );
    expect(screen.getByText(/Last updated by Ada Admin/)).toBeInTheDocument();
  });

  it("saves the company display name trimmed, and blank as null", () => {
    mocks.isAdmin = true;
    mocks.settingsQuery.mockReturnValue({ data: settings, isError: false });
    render(<AgentPanel />);
    const field = screen.getByLabelText("Company name used in AI messages");
    expect(field).toHaveAttribute("placeholder", "Workspace name");
    fireEvent.change(field, { target: { value: "  MOTM Technologies " } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));
    expect(mocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ companyDisplayName: "MOTM Technologies" }),
      expect.any(Object),
    );
  });

  it("offers the starter template when there is no playbook, and saves it as a new version", () => {
    mocks.isAdmin = true;
    mocks.settingsQuery.mockReturnValue({ data: settings, isError: false });
    render(<AgentPanel />);
    const saveButton = screen.getByRole("button", { name: "Save as new version" });
    expect(saveButton).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Insert starter template" }));
    expect((screen.getByLabelText("Playbook") as HTMLTextAreaElement).value).toContain(
      "# When to hand off to the rep",
    );
    fireEvent.click(saveButton);
    expect(mocks.save).toHaveBeenCalledWith(
      expect.stringContaining("# Who we are"),
      expect.any(Object),
    );
  });
});
