import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAdmin: false,
  panel: vi.fn(),
  enroll: vi.fn(),
  stop: vi.fn(),
  setLiveTest: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/store", () => {
  const mutation = (fn = vi.fn()) => ({ mutate: fn, mutateAsync: fn, isPending: false });
  return {
    messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
    useIsAdmin: () => mocks.isAdmin,
    useSession: () => ({ currentUser: { id: "rep-1" } }),
    useLeadAgentPanel: () => mocks.panel(),
    useAgentDecision: () => ({ data: undefined, isLoading: false, error: null }),
    useEnrollLeads: () => mutation(mocks.enroll),
    usePauseLead: () => mutation(),
    useResumeLead: () => mutation(),
    useStopLead: () => mutation(mocks.stop),
    useWakeLead: () => mutation(),
    useSetLiveTest: () => mutation(mocks.setLiveTest),
    useRateDecision: () => mutation(),
    useReportDecision: () => mutation(),
    useResolveReport: () => mutation(),
  };
});

import { LeadAiPanel } from "./lead-ai-panel";

const panel = (status: string, extra: object = {}) => ({
  isLoading: false,
  error: null,
  data: {
    leadId: "lead-1",
    status,
    statusReason: "meeting_booked",
    statusChangedAt: "2026-10-23T05:30:00.000Z",
    touchCount: 2,
    lastTouchAt: null,
    nextWakeup: { id: "w-1", dueAt: "2026-10-24T04:30:00.000Z", reason: "timer" },
    liveTest: false,
    effectiveMode: "shadow",
    decisions: [],
    ...extra,
  },
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.isAdmin = false;
});

describe("LeadAiPanel", () => {
  it("E2: shows Live vs Shadow and the Live test pill to everyone; the toggle only to admins", () => {
    mocks.panel.mockReturnValue(panel("active", { liveTest: true, effectiveMode: "live" }));
    const { unmount } = render(<LeadAiPanel leadId="lead-1" />);
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Live test")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /AI live test contact/ })).toBeNull();
    unmount();

    mocks.isAdmin = true;
    mocks.panel.mockReturnValue(panel("active"));
    render(<LeadAiPanel leadId="lead-1" />);
    expect(screen.getByText("Shadow")).toBeTruthy();
    expect(screen.queryByText("Live test")).toBeNull();
    const toggle = screen.getByRole("switch", { name: /AI live test contact/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(mocks.setLiveTest).toHaveBeenCalledWith(
      { leadId: "lead-1", enabled: true },
      expect.any(Object),
    );
  });

  it("E2: decision rows show the send status with its reason", () => {
    mocks.panel.mockReturnValue(
      panel("active", {
        decisions: [
          {
            id: "d-1",
            createdAt: "2026-10-23T05:30:00.000Z",
            mode: "live",
            action: "send_whatsapp",
            outcome: "executed",
            reasoning: "r",
            messageSubject: null,
            messageBody: "Hi",
            sendAt: null,
            handoffTitle: null,
            newStage: null,
            stopReason: null,
            regenerated: false,
            error: null,
            rating: null,
            ratingReason: null,
            ratingNote: null,
            context: { company: null, deal: null },
            sendStatus: "cancelled",
            sentAt: null,
            sendError: null,
            cancelReason: "The contact replied after this message was written.",
            channel: "whatsapp",
            rules: null,
            grounding: null,
            openReports: 0,
          },
        ],
      }),
    );
    render(<LeadAiPanel leadId="lead-1" />);
    expect(screen.getByText("Cancelled")).toHaveAttribute(
      "title",
      "The contact replied after this message was written.",
    );
  });

  it("shows status, plain reason, touches and the next wake-up in IST", () => {
    mocks.panel.mockReturnValue(panel("paused"));
    render(<LeadAiPanel leadId="lead-1" />);
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText(/Paused while a meeting is booked/)).toBeTruthy();
    expect(screen.getByText(/24 Oct 2026, 10:00 am IST · Scheduled follow-up/)).toBeTruthy();
  });

  it("D2: a lead handed off by a reply links to the reply; other reasons don't", () => {
    mocks.panel.mockReturnValue(panel("handed_off", { statusReason: "lead_replied" }));
    const { unmount } = render(<LeadAiPanel leadId="lead-1" />);
    expect(screen.getByText("Read reply")).toBeTruthy();
    unmount();
    mocks.panel.mockReturnValue(panel("paused"));
    render(<LeadAiPanel leadId="lead-1" />);
    expect(screen.queryByText("Read reply")).toBeNull();
  });

  it("hides every admin button from salespeople", () => {
    for (const status of ["none", "active", "paused", "stopped"]) {
      mocks.panel.mockReturnValue(panel(status));
      const { unmount } = render(<LeadAiPanel leadId="lead-1" />);
      for (const name of ["Enroll", "Pause", "Resume", "Stop", "Wake now"]) {
        expect(screen.queryByRole("button", { name }), `${status} ${name}`).toBeNull();
      }
      unmount();
    }
  });

  it("shows admins the buttons that fit the status", () => {
    mocks.isAdmin = true;
    const visible = (status: string) => {
      mocks.panel.mockReturnValue(panel(status));
      const { unmount } = render(<LeadAiPanel leadId="lead-1" />);
      const names = ["Enroll", "Pause", "Resume", "Stop", "Wake now"].filter((name) =>
        screen.queryByRole("button", { name }),
      );
      unmount();
      return names;
    };
    expect(visible("none")).toEqual(["Enroll"]);
    expect(visible("active")).toEqual(["Pause", "Stop", "Wake now"]);
    expect(visible("handed_off")).toEqual(["Resume", "Stop"]);
    expect(visible("stopped")).toEqual(["Enroll"]);
  });

  it("Stop asks for confirmation and sends the optional note", async () => {
    mocks.isAdmin = true;
    mocks.stop.mockResolvedValue({});
    mocks.panel.mockReturnValue(panel("active"));
    render(<LeadAiPanel leadId="lead-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(mocks.stop).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Asked by rep" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(mocks.stop).toHaveBeenCalledWith({ leadId: "lead-1", note: "Asked by rep" });
  });
});
