import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const settings = {
  mode: "off",
  sendDays: [1, 2, 3, 4, 5, 6],
  sendWindowStart: "09:30",
  sendWindowEnd: "19:00",
  minGapHours: 48,
  maxTouches7d: 2,
  maxTouchesTotal: 8,
  emailMaxWords: 160,
  whatsappMaxWords: 75,
  bannedPhrases: ["thanks for connecting", "today"],
  styleExamples: "Hi Ravi, thanks for the call.",
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
  liveScope: "test_contacts",
  liveSince: null,
  liveContactCount: 0,
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
  ready: false,
  preview: vi.fn(),
}));

const readiness = (ready: boolean) => ({
  ready,
  rated: ready ? 60 : 12,
  goodPct: ready ? 95 : 80,
  seriousBad: 0,
  reasons: ready ? [] : ["Rate at least 50 decisions (12 rated so far)."],
});

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
    useResetReadiness: () => mutation(vi.fn()),
    useAgentPlaybooks: () => ({ data: { currentVersion: null, data: [] }, isError: false }),
    useSavePlaybook: () => mutation(mocks.save),
    useRestorePlaybook: () => mutation(mocks.restore),
    useAgentStats: () => ({
      data: {
        mode: "live",
        readiness: readiness(mocks.ready),
        live: {
          scope: "test_contacts",
          liveSince: null,
          liveContacts: 1,
          sentToday: 3,
          sentThisMonth: 9,
        },
        messageRules: {
          bannedPhrases: ["thanks for connecting", "today"],
          emailMaxWords: 160,
          whatsappMaxWords: 75,
          styleExamples: "Hi Ravi, thanks for the call.",
        },
      },
      isError: false,
    }),
    useAgentLivePreview: (scope: string | null) =>
      mocks.preview(scope) ?? { data: undefined, error: null },
  };
});

import { AgentPanel } from "./agent-panel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentPanel", () => {
  it("salespeople see only the message rules, read-only, and never load the settings", () => {
    mocks.isAdmin = false;
    render(<AgentPanel />);
    expect(mocks.settingsQuery).not.toHaveBeenCalled();
    expect(screen.getByText("Message rules")).toBeInTheDocument();
    expect(screen.getByText("WhatsApp 75 words · email 160 words")).toBeInTheDocument();
    expect(screen.getByText("thanks for connecting, today")).toBeInTheDocument();
    expect(screen.getByText("Only admins can change these.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save message rules" })).toBeNull();
    expect(screen.queryByText("AI agent limits")).toBeNull();
  });

  it("E3a: others read the style examples; admins edit them", async () => {
    mocks.isAdmin = false;
    const { unmount } = render(<AgentPanel />);
    expect(screen.getByText("Hi Ravi, thanks for the call.")).toBeInTheDocument();
    expect(screen.getByText("Only admins can change the examples.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save style examples" })).toBeNull();
    unmount();

    mocks.isAdmin = true;
    mocks.settingsQuery.mockReturnValue({ data: settings, isError: false });
    render(<AgentPanel />);
    const field = screen.getByLabelText("Style examples");
    expect(field).toHaveValue("Hi Ravi, thanks for the call.");
    fireEvent.change(field, { target: { value: "x".repeat(6001) } });
    fireEvent.click(screen.getByRole("button", { name: "Save style examples" }));
    expect(await screen.findByText("At most 6000 characters.")).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "Hi Asha, good to speak today." } });
    fireEvent.click(screen.getByRole("button", { name: "Save style examples" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        { styleExamples: "Hi Asha, good to speak today." },
        expect.any(Object),
      ),
    );
  });

  it("E2b: admins edit banned phrases (one per line) and word limits", async () => {
    mocks.isAdmin = true;
    mocks.settingsQuery.mockReturnValue({ data: settings, isError: false });
    render(<AgentPanel />);
    expect(screen.getByLabelText("Banned phrases (one per line)")).toHaveValue(
      "thanks for connecting\ntoday",
    );
    fireEvent.change(screen.getByLabelText("Banned phrases (one per line)"), {
      target: { value: " just checking in \n\nfree\n" },
    });
    fireEvent.change(screen.getByLabelText("WhatsApp max words"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Save message rules" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        { bannedPhrases: ["just checking in", "free"], whatsappMaxWords: 60, emailMaxWords: 160 },
        expect.any(Object),
      ),
    );
  });

  it("E2b: message rules are validated before saving", async () => {
    mocks.isAdmin = true;
    mocks.settingsQuery.mockReturnValue({ data: settings, isError: false });
    render(<AgentPanel />);
    fireEvent.change(screen.getByLabelText("Email max words (body)"), { target: { value: "501" } });
    fireEvent.change(screen.getByLabelText("Banned phrases (one per line)"), {
      target: { value: "x".repeat(61) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save message rules" }));
    expect(await screen.findByText("At most 500 words.")).toBeInTheDocument();
    expect(screen.getByText("Each phrase can be at most 60 characters.")).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("asks for confirmation before switching Off → Shadow, then saves the mode", () => {
    mocks.isAdmin = true;
    mocks.settingsQuery.mockReturnValue({ data: settings, isError: false });
    render(<AgentPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Shadow" }));
    expect(screen.getByText(/Nothing is sent to leads in Shadow mode/)).toBeInTheDocument();
    expect(
      screen.getByText(/12 leads are enrolled in the AI and will be reviewed now/),
    ).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Turn on Shadow" }));
    expect(mocks.update).toHaveBeenCalledWith({ mode: "shadow" }, expect.any(Object));
  });

  it("Live: the confirm shows the gate numbers, contacts that become live and runs to cancel, then saves mode + scope", () => {
    mocks.isAdmin = true;
    mocks.ready = false;
    mocks.settingsQuery.mockReturnValue({ data: settings, isError: false });
    mocks.preview.mockImplementation((scope: string | null) => ({
      data: scope && {
        scope,
        readiness: readiness(false),
        allowed: true,
        message: null,
        liveContacts: 2,
        workflowRunsToCancel: 1,
      },
      error: null,
    }));
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(mocks.preview).toHaveBeenLastCalledWith("test_contacts");
    expect(screen.getByText("Go live: Test contacts only?")).toBeInTheDocument();
    expect(screen.getByTestId("live-contacts")).toHaveTextContent(
      "2 contacts will get real WhatsApp and email",
    );
    expect(screen.getByTestId("runs-to-cancel")).toHaveTextContent(
      "1 workflow run will be cancelled",
    );
    expect(screen.getAllByText("12 / 50").length).toBeGreaterThan(0);
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Go live" }));
    expect(mocks.update).toHaveBeenCalledWith(
      { mode: "live", liveScope: "test_contacts" },
      expect.any(Object),
    );
  });

  it("Live: pilot and all are disabled until the gate passes; the red Live banner shows", () => {
    mocks.isAdmin = true;
    mocks.ready = false;
    mocks.settingsQuery.mockReturnValue({ data: { ...settings, mode: "live" }, isError: false });
    mocks.preview.mockReturnValue({ data: undefined, error: null });
    render(<AgentPanel />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Live: the AI sends real messages to 1 contact (Test contacts only). 3 sent today",
    );
    expect(screen.getByRole("button", { name: "Test contacts only" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "New leads (pilot)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "All AI contacts" })).toBeDisabled();
    expect(screen.getByText(/unlock when the go-live gate passes/)).toBeInTheDocument();
    expect(screen.getAllByText("Not passed").length).toBeGreaterThan(0);
  });

  it("Live: a wider scope confirms (refused by the gate → Go live disabled with the reason); narrowing saves at once", () => {
    mocks.isAdmin = true;
    mocks.ready = true;
    mocks.settingsQuery.mockReturnValue({
      data: { ...settings, mode: "live", liveScope: "new_leads" },
      isError: false,
    });
    mocks.preview.mockImplementation((scope: string | null) => ({
      data: scope && {
        scope,
        readiness: readiness(true),
        allowed: false,
        message: "The go-live gate isn't passed yet.",
        liveContacts: 40,
        workflowRunsToCancel: 7,
      },
      error: null,
    }));
    render(<AgentPanel />);
    fireEvent.click(screen.getByRole("button", { name: "All AI contacts" }));
    expect(screen.getByText("The go-live gate isn't passed yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go live" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Test contacts only" }));
    expect(mocks.update).toHaveBeenCalledWith({ liveScope: "test_contacts" }, expect.any(Object));
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
