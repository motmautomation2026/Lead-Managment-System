import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactDetail, TimelineEvent } from "@/types";

const mocks = vi.hoisted(() => ({
  contact: null as unknown as ContactDetail,
  timeline: [] as TimelineEvent[],
  updateLead: vi.fn(),
  createDeal: vi.fn(),
  leadList: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const baseContact = (): ContactDetail =>
  ({
    id: "c-1",
    firstName: "Asha",
    lastName: "Rao",
    companyText: "Tata Motors",
    company: { id: "co-1", name: "Tata Motors", domain: "tata.test" },
    deals: [
      {
        id: "d-1",
        name: "Tata – Fleet",
        stage: "meeting_scheduled",
        amount: 1_500_000,
        currency: "INR",
        closedAt: null,
      },
    ],
    jobTitle: "CTO",
    industry: "Automotive",
    phone: "+919876543210",
    email: "asha@tata.test",
    source: "website",
    serviceInterest: "Cold Calling",
    revenueRange: "",
    ownerId: "u-1",
    ownerName: "Rep One",
    pipelineStage: "connected_qualifying",
    lifecycleState: "active",
    automationMode: "manual",
    responseState: "no_response",
    doNotContact: false,
    agentStatus: "none",
    agentTouchCount: 0,
    lastActivityAt: "2026-10-20T10:00:00.000Z",
    nextAction: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
  }) as ContactDetail;

const event = (id: string, kind: string, title: string, extra: Partial<TimelineEvent> = {}) =>
  ({
    id,
    leadId: "c-1",
    at: `2026-10-2${id}T10:00:00.000Z`,
    kind,
    title,
    actor: "Rep One",
    source: "manual",
    ...extra,
  }) as TimelineEvent;

const noop = vi.fn(async () => undefined);
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/features/agent/lead-ai-panel", () => ({ LeadAiPanel: () => <div>AI panel</div> }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useSession: () => ({
    users: [{ id: "u-1", name: "Rep One", active: true }],
    userName: () => "Rep One",
  }),
  useIsAdmin: () => false,
  useContact: () => ({ data: mocks.contact, isLoading: false, error: null }),
  useLead: () => ({
    notes: [
      { id: "n-1", author: "Rep One", at: "2026-10-20T10:00:00.000Z", body: "Called about fleet" },
    ],
    contactability: [],
  }),
  useLeadList: (enabled: boolean) => {
    mocks.leadList(enabled);
    return { data: undefined };
  },
  useLeadMutations: () => ({
    isPending: false,
    updateLead: mocks.updateLead,
    addNote: noop,
    logCall: noop,
    logCommunication: noop,
    setLifecycle: noop,
    setAutomation: noop,
    markDnc: noop,
    reactivateFromDnc: noop,
    deleteLead: noop,
  }),
  useTasks: () => ({
    tasks: [],
    completeTask: noop,
    cancelTask: noop,
    addTask: noop,
    updateTask: noop,
  }),
  useMeetings: () => ({
    meetings: [
      {
        id: "m-1",
        leadId: "c-1",
        dealId: "d-1",
        title: "Discovery call",
        at: "2026-10-28T05:30:00.000Z",
        durationMin: 30,
        status: "scheduled",
        calendarSyncStatus: "not_applicable",
        createdAt: "",
        updatedAt: "",
      },
    ],
    addMeeting: noop,
    recordOutcome: noop,
  }),
  useProposals: () => ({
    proposals: [],
    isPending: false,
    addProposal: noop,
    setProposalStatus: noop,
  }),
  useAutomations: () => ({
    workflows: [],
    templates: [],
    runs: [],
    scheduledActions: [],
    enrollLead: noop,
  }),
  useTimeline: () => ({ timeline: mocks.timeline, isLoading: false, error: null }),
  useCompany: () => ({
    data: { id: "co-1", name: "Tata Motors", industry: "Automotive", contactCount: 3 },
  }),
  useCreateDeal: () => ({ mutateAsync: mocks.createDeal, isPending: false }),
}));

import { ContactRecordPage } from "./contact-record-page";

async function renderPage() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => <ContactRecordPage contactId="c-1" />,
      }),
      createRoute({ getParentRoute: () => root, path: "/contacts", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/deals/$dealId", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/meetings", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/proposals", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Asha Rao" });
}
// Below lg (jsdom) the record is one column of tabs.
const openTab = (name: string) => {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
};

beforeEach(() => {
  mocks.contact = baseContact();
  mocks.timeline = [];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ContactRecordPage", () => {
  it("renders the header and every panel", async () => {
    await renderPage();
    expect(screen.getByText("CTO · Tata Motors")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "About" })).toBeTruthy();
    // Overview (default): journey + next action + tasks.
    expect(screen.getByText("Next action")).toBeTruthy();
    expect(screen.getByText("Open tasks")).toBeTruthy();

    openTab("About");
    expect(screen.getByText("asha@tata.test")).toBeTruthy();
    openTab("Notes");
    expect(screen.getByText("Called about fleet")).toBeTruthy();
    openTab("Meetings & proposals");
    expect(screen.getByText("Discovery call")).toBeTruthy();
    expect(screen.getByText(/Deal: Tata – Fleet/)).toBeTruthy();
    openTab("Automation");
    expect(screen.getByText("Workflow runs")).toBeTruthy();
    openTab("Associations");
    expect(screen.getByText("3 contacts")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Tata – Fleet" })).toHaveAttribute(
      "href",
      "/deals/d-1",
    );
    expect(screen.getByText("AI panel")).toBeTruthy();
  });

  it("inline edit saves through PATCH /leads/:id and shows backend errors inline", async () => {
    mocks.updateLead.mockRejectedValueOnce(new Error("That email belongs to another contact."));
    await renderPage();
    openTab("About");
    fireEvent.click(screen.getByRole("button", { name: "Edit Email" }));
    const input = screen.getByRole("textbox", { name: "Email" });
    fireEvent.change(input, { target: { value: "  Asha@Other.test " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.updateLead).toHaveBeenCalledWith("c-1", { email: "asha@other.test" }),
    );
    expect(await screen.findByText("That email belongs to another contact.")).toBeTruthy();

    // Same rules as Create contact: an invalid email never reaches the API.
    mocks.updateLead.mockClear();
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(mocks.updateLead).not.toHaveBeenCalled();

    mocks.updateLead.mockResolvedValueOnce({});
    fireEvent.change(input, { target: { value: "asha@tata.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Email saved"));
  });

  it("DNC: contact actions are disabled and the banner offers removal", async () => {
    mocks.contact = {
      ...baseContact(),
      doNotContact: true,
      lifecycleState: "do_not_contact",
      dncReason: "Asked us to stop",
    };
    await renderPage();
    expect(screen.getByRole("status")).toHaveTextContent("Do Not Contact. Asked us to stop");
    for (const name of ["Log call", "Meeting", "Task", "Proposal", "Log email / WhatsApp"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: /^Note/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove suppression" })).toBeTruthy();
  });

  it("dialogs get the contact by id, never from the leads list (B11)", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Log call/ }));
    expect(await screen.findByRole("dialog", { name: "Log call - Asha Rao" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    // Meeting and proposal dialogs are mounted with the contact's id: no list is loaded.
    expect(mocks.leadList).toHaveBeenCalled();
    expect(mocks.leadList.mock.calls.every(([enabled]) => enabled === false)).toBe(true);
  });

  it("creates a deal with the default name", async () => {
    mocks.createDeal.mockResolvedValue({ id: "d-2" });
    await renderPage();
    openTab("Associations");
    fireEvent.click(screen.getByRole("button", { name: "Create deal Deals" }));
    const dialog = await screen.findByRole("dialog", { name: "Create deal" });
    expect(within(dialog).getByLabelText("Deal name")).toHaveValue("Tata Motors – Cold Calling");
    fireEvent.change(within(dialog).getByLabelText("Amount (INR)"), { target: { value: "-5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create deal" }));
    expect(await within(dialog).findByText("Enter an amount of 0 or more.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Amount (INR)"), {
      target: { value: "250000" },
    });
    fireEvent.change(within(dialog).getByLabelText("Expected close date"), {
      target: { value: "2026-12-31" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create deal" }));
    await waitFor(() =>
      expect(mocks.createDeal).toHaveBeenCalledWith({
        leadId: "c-1",
        name: "Tata Motors – Cold Calling",
        stage: "qualified",
        amount: 250000,
        currency: "INR",
        expectedCloseDate: "2026-12-31",
      }),
    );
  });

  it("activity filter chips narrow the timeline", async () => {
    mocks.timeline = [
      event("1", "note", "Note added"),
      event("2", "call", "Call logged"),
      event("3", "system", "Deal created", { relatedDealId: "d-1" }),
      event("4", "automation", "AI Agent Paused", { actor: "AI Agent", source: "automation" }),
      event("5", "whatsapp", "WhatsApp reply"),
      event("6", "stage", "Stage changed"),
    ];
    await renderPage();
    openTab("Activity");
    expect(screen.getByText("Note added")).toBeTruthy();
    expect(screen.getByText("Stage changed")).toBeTruthy();
    const pick = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
    pick("Deals");
    expect(screen.getByText("Deal created")).toBeTruthy();
    expect(screen.queryByText("Note added")).toBeNull();
    pick("AI");
    expect(screen.getByText("AI Agent Paused")).toBeTruthy();
    pick("Messages");
    expect(screen.getByText("WhatsApp reply")).toBeTruthy();
    pick("System");
    expect(screen.getByText("Stage changed")).toBeTruthy();
    expect(screen.queryByText("Deal created")).toBeNull();
    pick("Tasks");
    expect(screen.getByText("Nothing of this type yet")).toBeTruthy();
  });
});
