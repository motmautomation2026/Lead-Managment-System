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
  openDeal: vi.fn(),
  timelineKinds: [] as unknown[],
  fetchNextPage: vi.fn(),
  openTask: vi.fn(),
  setStatus: vi.fn(),
  tasks: [] as unknown[],
  proposals: [] as unknown[],
  runParams: [] as unknown[],
  stepParams: [] as unknown[],
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  addNote: vi.fn(async () => undefined),
  logCall: vi.fn(async () => ({})),
  wide: false,
  completeTask: vi.fn(async () => undefined),
  reopenTask: vi.fn(async () => undefined),
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
vi.mock("@/app/add-lead-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/add-lead-context")>()),
  useCreateDealDialog: () => ({ open: mocks.openDeal }),
  useCreateTaskDialog: () => ({ open: mocks.openTask }),
}));
vi.mock("@/features/agent/lead-ai-panel", () => ({ LeadAiPanel: () => <div>AI panel</div> }));
// UX-3: jsdom has no matchMedia (phone layout: rail = tabs); `mocks.wide` renders the laptop layout.
vi.mock("@/lib/use-media-query", () => ({ useMediaQuery: () => mocks.wide }));
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
  useLeadMutations: () => ({
    isPending: false,
    updateLead: mocks.updateLead,
    addNote: mocks.addNote,
    logCall: mocks.logCall,
    logCommunication: noop,
    setLifecycle: noop,
    setAutomation: noop,
    markDnc: noop,
    reactivateFromDnc: noop,
    deleteLead: noop,
  }),
  useTaskList: () => ({ data: { pages: [{ data: mocks.tasks, nextCursor: null }] } }),
  useMeetingList: () => ({
    data: {
      pages: [
        {
          data: [
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
              ownerName: "Rep One",
              contact: { id: "c-1", name: "Asha Rao" },
              company: null,
              deal: { id: "d-1", name: "Tata – Fleet" },
            },
          ],
          nextCursor: null,
        },
      ],
    },
  }),
  useProposalList: () => ({ data: { pages: [{ data: mocks.proposals, nextCursor: null }] } }),
  useCompleteTask: () => ({ mutateAsync: mocks.completeTask }),
  useReopenTask: () => ({ mutateAsync: mocks.reopenTask }),
  useCancelTask: () => ({ mutateAsync: noop }),
  useCreateTask: () => ({ mutateAsync: noop }),
  useUpdateTask: () => ({ mutateAsync: noop }),
  useRecordMeetingOutcome: () => ({ mutateAsync: noop }),
  useCreateProposal: () => ({ mutateAsync: noop }),
  useCreateMeeting: () => ({ mutateAsync: noop, isPending: false }),
  useUpdateMeeting: () => ({ mutateAsync: noop, isPending: false }),
  useSetProposalStatus: () => ({ mutateAsync: mocks.setStatus }),
  useAutomations: () => ({
    workflows: [],
    templates: [],
    enrollLead: noop,
  }),
  // C6b: the Automation section reads the runs / scheduled steps lists filtered by contact.
  useRunList: (params: unknown) => {
    mocks.runParams.push(params);
    return {
      data: {
        pages: [
          {
            data: [
              {
                id: "r-1",
                workflowId: "w-1",
                version: 2,
                leadId: "c-1",
                status: "waiting",
                startedAt: "2026-10-20T10:00:00.000Z",
                contact: { id: "c-1", name: "Asha Rao" },
                workflow: { id: "w-1", name: "Nurture" },
                currentStepAction: "send_email",
              },
            ],
            nextCursor: null,
          },
        ],
      },
      hasNextPage: false,
    };
  },
  useScheduledActionList: (params: unknown) => {
    mocks.stepParams.push(params);
    return { data: { pages: [{ data: [], nextCursor: null }] }, hasNextPage: false };
  },
  useContactTimeline: (_id: string, kind: string[]) => {
    mocks.timelineKinds.push(kind);
    // Server-side filtering: the mock returns rows whose "type" is in kind.
    const rows = kind.length ? mocks.timeline.filter((e) => kind.includes(e.kind)) : mocks.timeline;
    return {
      data: { pages: [{ data: rows, nextCursor: "next" }] },
      isLoading: false,
      error: null,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: mocks.fetchNextPage,
    };
  },
  useCompanyTimeline: () => ({ data: undefined, isLoading: false, error: null }),
  useLatestReplyDraft: () => ({ data: { draft: null } }),
  useInboundReply: () => ({ data: undefined, isLoading: false, error: null }),
  useCorrectReplyLabel: () => ({ mutate: vi.fn(), isPending: false }),
  useDealTimeline: () => ({ data: undefined, isLoading: false, error: null }),
  useCompanySearch: (input: string) => ({
    data:
      input.trim().length >= 2
        ? { data: [{ id: "co-9", name: "Tata Motors Finance", domain: null }] }
        : undefined,
    isFetching: false,
  }),
  useCreateCompany: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCompany: () => ({
    data: { id: "co-1", name: "Tata Motors", industry: "Automotive", contactCount: 3 },
  }),
}));

import { ContactRecordPage } from "./contact-record-page";
import type { ContactRecordSearch } from "./contact-helpers";

async function renderPage(link?: ContactRecordSearch) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => <ContactRecordPage contactId="c-1" link={link ?? {}} />,
      }),
      createRoute({ getParentRoute: () => root, path: "/contacts", component: () => null }),
      createRoute({
        getParentRoute: () => root,
        path: "/companies/$companyId",
        component: () => null,
      }),
      createRoute({ getParentRoute: () => root, path: "/deals/$dealId", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/meetings", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/proposals", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/tasks", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Asha Rao" });
}
// Below lg (jsdom) the rail cards are tabs under the header.
const openTab = (name: string) => {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
};

beforeEach(() => {
  mocks.wide = false;
  window.localStorage.clear();
  mocks.contact = baseContact();
  mocks.timeline = [];
  mocks.tasks = [];
  mocks.proposals = [];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ContactRecordPage (UX-3 record layout)", () => {
  it("D2: a Read reply link opens Activity filtered to messages", async () => {
    await renderPage({ tab: "activity", activity: "messages", reply: "latest" });
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Messages" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(mocks.timelineKinds.at(-1)).toEqual(["messages"]);
  });

  it("sticky header: breadcrumb, identity, pills and the primary actions", async () => {
    mocks.contact = {
      ...baseContact(),
      hotScore: 72,
      hotBand: "hot",
      hotReasons: [],
      agentStatus: "active",
      whatsappNumber: { id: "n-1", label: "Sales 1" },
    };
    await renderPage();
    const crumbs = screen.getByRole("navigation", { name: "Record breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Contacts" })).toHaveAttribute(
      "href",
      "/contacts",
    );
    expect(within(crumbs).getByText("Asha Rao")).toBeTruthy();
    expect(screen.getByText(/^CTO ·/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Hot lead, score 72/ })).toBeTruthy();
    expect(screen.getByText("AI: Active")).toBeTruthy();
    expect(screen.getByText("WhatsApp · Sales 1")).toBeTruthy();
    const header = within(screen.getByRole("banner"));
    for (const name of ["Log call", "Note", "Task", "Meeting", "Proposal", "More"]) {
      expect(header.getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    // Activity is the main column; the rail cards are tabs on phones.
    for (const name of ["Activity", "About", "Company", "Open deals", "Next tasks", "AI"]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(
      screen.getByText("No next action assigned. Every active contact needs one."),
    ).toBeTruthy();
  });

  it("inline owner in the header saves through PATCH /leads/:id", async () => {
    const { ownerId: _id, ownerName: _name, ...unowned } = baseContact();
    mocks.contact = unowned as ContactDetail;
    mocks.updateLead.mockResolvedValue({});
    await renderPage();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Owner" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Rep One" }));
    await waitFor(() => expect(mocks.updateLead).toHaveBeenCalledWith("c-1", { ownerId: "u-1" }));
    expect(mocks.toast.success).toHaveBeenCalledWith("Owner updated");
  });

  it("panels: About, company, deals, meetings & proposals, automation", async () => {
    await renderPage();
    openTab("About");
    expect(screen.getByText("asha@tata.test")).toBeTruthy();
    openTab("Company");
    expect(screen.getByText("3 contacts")).toBeTruthy();
    openTab("Open deals");
    expect(screen.getByRole("link", { name: "Tata – Fleet" })).toHaveAttribute(
      "href",
      "/deals/d-1",
    );
    openTab("AI");
    expect(screen.getByText("AI panel")).toBeTruthy();
    openTab("Meetings & proposals");
    expect(screen.getByText("Discovery call")).toBeTruthy();
    expect(screen.getByText(/Deal: Tata – Fleet/)).toBeTruthy();
    openTab("Automation");
    expect(screen.getByText("Workflow runs")).toBeTruthy();
    expect(screen.getByText("Nurture · V2")).toBeTruthy();
    expect(mocks.runParams).toContainEqual({ contactId: "c-1", limit: 20 });
    expect(mocks.stepParams).toContainEqual({
      contactId: "c-1",
      sort: "scheduledFor:asc",
      limit: 50,
    });
    expect(screen.getByRole("link", { name: "View all runs" })).toHaveAttribute(
      "href",
      "/automations/runs?contactId=c-1",
    );
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
    mocks.updateLead.mockClear();
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(mocks.updateLead).not.toHaveBeenCalled();
  });

  it("DNC: contact actions are disabled, the header warns and the banner offers removal", async () => {
    mocks.contact = {
      ...baseContact(),
      doNotContact: true,
      lifecycleState: "do_not_contact",
      dncReason: "Asked us to stop",
    };
    await renderPage();
    expect(screen.getByRole("status")).toHaveTextContent("Do Not Contact. Asked us to stop");
    const header = within(screen.getByRole("banner"));
    for (const name of ["Log call", "Meeting", "Task", "Proposal"]) {
      expect(header.getByRole("button", { name: new RegExp(`^${name}`) })).toBeDisabled();
    }
    expect(header.getByRole("button", { name: /^Note/ })).toBeEnabled();
    expect(header.getAllByText("Do Not Contact")).toHaveLength(1);
    // No quick call from the composer either.
    expect(screen.queryByRole("button", { name: "Call" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove suppression" })).toBeTruthy();
  });

  it("composer: a note without a dialog; a call that did not connect; Connected opens the dialog", async () => {
    mocks.contact = {
      ...baseContact(),
      nextAction: {
        taskId: "t-9",
        type: "call",
        title: "First call",
        dueAt: "2026-10-26T04:30:00.000Z",
        ownerId: "u-1",
        ownerName: "Rep One",
      },
    } as ContactDetail;
    await renderPage();
    expect(screen.getByText("First call")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: /^Note/ }));
    const box = screen.getByRole("textbox", { name: "New note" });
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: "  Wants the deck  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() =>
      expect(mocks.addNote).toHaveBeenCalledWith("c-1", "Wants the deck", undefined),
    );
    expect(mocks.toast.success).toHaveBeenCalledWith("Note added");

    fireEvent.click(screen.getByRole("button", { name: "Call" }));
    fireEvent.click(screen.getByRole("button", { name: "No answer" }));
    await waitFor(() =>
      expect(mocks.logCall).toHaveBeenCalledWith("c-1", {
        connected: false,
        notConnectedReason: "no_answer",
        notes: undefined,
        taskId: "t-9",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connected…" }));
    expect(await screen.findByRole("dialog", { name: "Log call - Asha Rao" })).toBeTruthy();
  });

  it("next tasks: list endpoint by contact, complete inline, View all, Task action", async () => {
    mocks.tasks = [
      {
        id: "t-1",
        title: "Send the deck",
        type: "follow_up",
        dueAt: "2026-10-26T04:30:00.000Z",
        status: "open",
        origin: "agent",
        isOverdue: true,
      },
    ];
    await renderPage();
    openTab("Next tasks");
    expect(screen.getByText("Send the deck")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View all tasks" })).toHaveAttribute(
      "href",
      "/tasks?contactId=c-1&view=everyone",
    );
    // UX-3: Complete inline with Undo (POST /tasks/:id/reopen).
    fireEvent.click(screen.getByRole("button", { name: "Complete Send the deck" }));
    await waitFor(() => expect(mocks.completeTask).toHaveBeenCalledWith("t-1"));
    const [message, options] = mocks.toast.success.mock.calls.at(-1) as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe("“Send the deck” completed");
    expect(options.action.label).toBe("Undo");
    options.action.onClick();
    await waitFor(() => expect(mocks.reopenTask).toHaveBeenCalledWith("t-1"));
    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: /^Task/ }));
    expect(mocks.openTask).toHaveBeenCalledWith({ contact: { id: "c-1", name: "Asha Rao" } });
  });

  it("activity: paginated feed, chips group server kinds, Load more", async () => {
    mocks.timeline = [
      event("1", "notes", "Note added"),
      event("2", "deals", "Deal created", { relatedDealId: "d-1" }),
      event("3", "meetings", "Meeting reminder sent"),
    ];
    await renderPage();
    expect(screen.getByText("Note added")).toBeTruthy();
    expect(mocks.timelineKinds.at(-1)).toEqual([]);
    expect(
      within(screen.getByRole("group", { name: "Activity type" }))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["All", "Calls", "Messages", "Notes", "AI", "Meetings & proposals", "System"]);
    fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(mocks.timelineKinds.at(-1)).toEqual(["system", "tasks", "deals"]);
    expect(screen.getByText("Deal created")).toBeTruthy();
    expect(screen.queryByText("Note added")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Meetings & proposals" }));
    expect(mocks.timelineKinds.at(-1)).toEqual(["meetings", "proposals"]);
    expect(screen.getByText("Meeting reminder sent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Calls" }));
    expect(screen.getByText("Nothing of this type yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mocks.fetchNextPage).toHaveBeenCalled();
  });

  it("D2 visibility unchanged: replies show 'Show message' only to readers", async () => {
    const reply = (canRead: boolean) => ({
      channel: "whatsapp" as const,
      messageId: "wa-1",
      hasText: true,
      canRead,
      canCorrect: canRead,
      label: null,
      labelSource: null,
      labelBy: null,
      classifying: false,
    });
    mocks.timeline = [event("1", "messages", "WhatsApp reply received", { reply: reply(true) })];
    await renderPage();
    expect(screen.getByRole("button", { name: "Show message" })).toBeTruthy();
    cleanup();
    mocks.timeline = [event("1", "messages", "WhatsApp reply received", { reply: reply(false) })];
    await renderPage();
    expect(screen.queryByRole("button", { name: "Show message" })).toBeNull();
    expect(screen.getByText("Only the contact owner and admins can read replies.")).toBeTruthy();
  });

  it("laptop: right rail cards collapse and the choice is remembered", async () => {
    mocks.wide = true;
    await renderPage();
    expect(screen.queryByRole("tab")).toBeNull();
    const about = screen.getByRole("button", { name: "About" });
    expect(about).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("asha@tata.test")).toBeTruthy();
    // Collapsed by default: Meetings & proposals, Automation (their lists mount only when opened).
    const rail = within(screen.getByRole("complementary", { name: "Details" }));
    expect(rail.getByRole("button", { name: /^Meetings & proposals/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("Discovery call")).toBeNull();
    fireEvent.click(about);
    expect(about).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("asha@tata.test")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("motmflow.rail.contact") ?? "{}")).toEqual({
      about: false,
    });
    cleanup();
    await renderPage();
    expect(screen.getByRole("button", { name: "About" })).toHaveAttribute("aria-expanded", "false");
  });

  it("dialogs get the contact by id, never from the leads list (B11)", async () => {
    await renderPage();
    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: /^Log call/ }));
    expect(await screen.findByRole("dialog", { name: "Log call - Asha Rao" })).toBeTruthy();
  });

  it("Create deal opens the app-wide dialog for this contact", async () => {
    await renderPage();
    openTab("Open deals");
    fireEvent.click(screen.getByRole("button", { name: "Create deal" }));
    expect(mocks.openDeal).toHaveBeenCalledWith({
      contact: { id: "c-1", name: "Asha Rao" },
      stay: true,
    });
  });

  it("Change company picks a company record and saves its name (the backend relinks)", async () => {
    mocks.updateLead.mockResolvedValue({});
    await renderPage();
    openTab("Company");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("dialog", { name: "Change company" });
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Company" }));
    fireEvent.change(screen.getByLabelText("Search companies"), { target: { value: "tata" } });
    fireEvent.click(await screen.findByRole("option", { name: /Tata Motors Finance/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.updateLead).toHaveBeenCalledWith("c-1", { company: "Tata Motors Finance" }),
    );
  });
});
