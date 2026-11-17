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
import type { DealDetail } from "@/types";

const mocks = vi.hoisted(() => ({
  deal: null as unknown,
  error: null as unknown,
  update: vi.fn(),
  move: vi.fn(),
  addMeeting: vi.fn(),
  openTask: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  feedKinds: [] as unknown[],
  addNote: vi.fn(async () => undefined),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class BackendError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
const noop = () => Promise.resolve();
const page = (rows: unknown[]) => ({
  data: { pages: [{ data: rows, nextCursor: null }] },
  isLoading: false,
  error: null,
  hasNextPage: false,
});
vi.mock("@/app/add-lead-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/add-lead-context")>()),
  useCreateTaskDialog: () => ({ open: mocks.openTask }),
}));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useSession: () => ({ users: [{ id: "u-1", name: "Asha Owner", active: true }] }),
  useDeal: () => ({ data: mocks.deal, isLoading: false, error: mocks.error }),
  useDeals: () =>
    page([
      { id: "d-1", name: "Acme rollout", stage: "negotiation", amount: 500000, currency: "INR" },
      { id: "d-2", name: "Acme phase 2", stage: "qualified", amount: null, currency: "INR" },
    ]),
  useDealTimeline: (_id: string, kind: string[]) => {
    mocks.feedKinds.push(kind);
    return page([
      {
        id: "t-1",
        leadId: "l-1",
        at: "2026-10-20T10:00:00.000Z",
        kind: "proposal",
        title: "Proposal emailed",
        actor: "Asha Owner",
        source: "manual",
        contact: { id: "l-1", name: "Ravi Kumar" },
      },
    ]);
  },
  useContactTimeline: () => page([]),
  useLeadMutations: () => ({ addNote: mocks.addNote, logCall: vi.fn() }),
  useCompanyTimeline: () => page([]),
  useUpdateDeal: () => ({ mutateAsync: mocks.update, isPending: false }),
  useMoveDealStage: () => ({ mutateAsync: mocks.move, isPending: false }),
  useCreateMeeting: () => ({ mutateAsync: mocks.addMeeting, isPending: false }),
  useUpdateMeeting: () => ({ mutateAsync: noop, isPending: false }),
  useCreateProposal: () => ({ mutateAsync: noop }),
  useSetProposalStatus: () => ({ mutateAsync: noop }),
  useTaskList: () =>
    page([
      {
        id: "t-1",
        title: "Chase the PO",
        dueAt: "2026-10-26T04:30:00.000Z",
        status: "open",
        isOverdue: false,
        ownerName: "Asha Owner",
      },
    ]),
  useMeetingList: () =>
    page([{ id: "m-1", title: "Intro call", at: "2099-01-05T05:30:00.000Z", status: "scheduled" }]),
  useProposalList: () =>
    page([
      {
        id: "p-1",
        title: "SEO retainer",
        amount: 500000,
        currency: "INR",
        status: "sent",
        allowedNextStatuses: ["accepted", "rejected"],
        lossReasonStatuses: ["rejected"],
      },
    ]),
  useAutomations: () => ({ templates: [] }),
  useCompanySearch: () => ({ data: undefined }),
  useCreateCompany: () => ({ mutateAsync: noop, isPending: false }),
}));

import { BackendError } from "@/lib/backend-client";
import { DealRecordPage } from "./deal-record-page";

const baseDeal = (extra: Partial<DealDetail> = {}): DealDetail => ({
  id: "d-1",
  name: "Acme rollout",
  stage: "negotiation",
  amount: 500000,
  currency: "INR",
  expectedCloseDate: "2026-11-30",
  owner: { id: "u-1", name: "Asha Owner" },
  company: { id: "co-1", name: "Acme" },
  contact: {
    id: "l-1",
    name: "Ravi Kumar",
    email: "ravi@acme.test",
    phone: null,
    lifecycle: "active",
  },
  source: "manual",
  closedAt: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  serviceInterest: "SEO",
  lossReason: null,
  lossNotes: null,
  createdBy: "Asha Owner",
  meetings: [
    {
      id: "m-1",
      title: "Intro call",
      at: "2099-01-05T05:30:00.000Z",
      status: "scheduled",
      outcome: null,
    },
  ],
  proposals: [
    {
      id: "p-1",
      title: "SEO retainer",
      amount: 450000,
      currency: "INR",
      status: "sent",
      sentAt: "2026-10-10T10:00:00.000Z",
      updatedAt: "2026-10-10T10:00:00.000Z",
    },
  ],
  ...extra,
});

async function renderPage() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <div>at {path}</div> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/deals/$dealId",
        component: () => <DealRecordPage dealId="d-1" />,
      }),
      stub("/deals"),
      stub("/contacts/$contactId"),
      stub("/companies/$companyId"),
      stub("/tasks"),
      stub("/meetings"),
      stub("/proposals"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/deals/d-1"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

const openMore = async () => {
  const header = within(screen.getByRole("banner"));
  fireEvent.pointerDown(header.getByRole("button", { name: /^More/ }), {
    button: 0,
    ctrlKey: false,
  });
  return screen.findByRole("menu");
};

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  mocks.deal = baseDeal();
  mocks.error = null;
  mocks.feedKinds = [];
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DealRecordPage", () => {
  it("sticky header: breadcrumb, identity, stage stepper; rail cards", async () => {
    await renderPage();
    expect(await screen.findByRole("heading", { name: "Acme rollout" })).toBeTruthy();
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("link", { name: "Deals" })).toHaveAttribute("href", "/deals");
    expect(header.getByRole("link", { name: "Ravi Kumar" })).toHaveAttribute(
      "href",
      "/contacts/l-1",
    );
    expect(header.getByRole("link", { name: "Acme" })).toHaveAttribute("href", "/companies/co-1");
    for (const name of ["Move stage", "Mark won", "Mark lost", "Log call", "Note", "More"]) {
      expect(header.getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    const bar = header.getByRole("list", { name: "Deal stage" });
    expect(within(bar).getByRole("button", { name: "Negotiation" })).toHaveAttribute(
      "aria-current",
      "step",
    );
    // Main column: the deal's feed.
    expect(screen.getByText("Proposal emailed")).toBeTruthy();
    // Other deals: collapsed by default, this deal excluded.
    const rail = within(screen.getByRole("complementary", { name: "Details" }));
    fireEvent.click(rail.getByRole("button", { name: /^Other deals of this contact/ }));
    expect(screen.getByRole("link", { name: "Acme phase 2" })).toHaveAttribute(
      "href",
      "/deals/d-2",
    );
    expect(screen.queryByRole("link", { name: "Acme rollout" })).toBeNull();
  });

  it("breadcrumb returns to the deals list with its last filters", async () => {
    window.sessionStorage.setItem(
      "motmflow.list./deals",
      JSON.stringify({ view: "mine", stage: ["qualified"] }),
    );
    await renderPage();
    const link = within(
      await screen.findByRole("navigation", { name: "Record breadcrumb" }),
    ).getByRole("link", { name: "Deals" });
    expect(link.getAttribute("href")).toMatch(/^\/deals\?/);
    expect(link.getAttribute("href")).toContain("view=mine");
    expect(link.getAttribute("href")).toContain("qualified");
  });

  it("composer: a note on a deal is saved on its contact with the deal id", async () => {
    await renderPage();
    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: /^Note/ }));
    const box = screen.getByRole("textbox", { name: "New note" });
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: "PO expected Friday" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() =>
      expect(mocks.addNote).toHaveBeenCalledWith("l-1", "PO expected Friday", "d-1"),
    );
  });

  it("stage bar: an open stage moves at once; Won opens the Close dialog", async () => {
    mocks.move.mockResolvedValue({});
    await renderPage();
    const bar = await screen.findByRole("list", { name: "Deal stage" });
    fireEvent.click(within(bar).getByRole("button", { name: "Proposal sent" }));
    await waitFor(() =>
      expect(mocks.move).toHaveBeenCalledWith({ id: "d-1", stage: "proposal_sent" }),
    );
    fireEvent.click(within(bar).getByRole("button", { name: "Won" }));
    expect(await screen.findByRole("dialog", { name: "Mark deal won" })).toBeTruthy();
    expect(mocks.move).toHaveBeenCalledTimes(1);
  });

  it("actions: Mark lost, Move stage, Schedule meeting with this deal", async () => {
    mocks.addMeeting.mockResolvedValue({});
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Mark lost/ }));
    expect(await screen.findByRole("dialog", { name: "Mark deal lost" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    fireEvent.pointerDown(screen.getByRole("button", { name: /Move stage/ }), {
      button: 0,
      ctrlKey: false,
    });
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Negotiation" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Won" })).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });

    fireEvent.click(within(await openMore()).getByRole("menuitem", { name: /Schedule meeting/ }));
    const dialog = await screen.findByRole("dialog", { name: "Schedule meeting" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Schedule|Save/ }));
    await waitFor(() =>
      expect(mocks.addMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ leadId: "l-1", dealId: "d-1" }),
      ),
    );
  });

  it("About: inline edit saves with PATCH and shows backend errors inline", async () => {
    mocks.update.mockRejectedValueOnce(new Error("Amount is too large.")).mockResolvedValue({});
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Amount" }));
    const input = screen.getByLabelText("Amount (INR)");
    fireEvent.change(input, { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter an amount of 0 or more.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "700000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Amount is too large.")).toBeTruthy();
    expect(mocks.update).toHaveBeenCalledWith({ id: "d-1", input: { amount: 700000 } });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith({ id: "d-1", input: { amount: null } }),
    );
  });

  it("feed chips and the Meetings & proposals / Next tasks rail cards", async () => {
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Meetings & proposals" }));
    await waitFor(() => expect(mocks.feedKinds).toContainEqual(["meetings", "proposals"]));
    expect(screen.getAllByText("SEO retainer").length).toBeGreaterThan(0);
    // C6a: the deal's tasks/meetings/proposals from the list endpoints, with View all links.
    expect(screen.getByText("Chase the PO")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View all tasks" })).toHaveAttribute(
      "href",
      "/tasks?dealId=d-1&view=everyone",
    );
    expect(screen.getByRole("link", { name: "View all proposals" })).toHaveAttribute(
      "href",
      "/proposals?dealId=d-1&view=everyone",
    );
    fireEvent.click(screen.getByRole("button", { name: "Change status of SEO retainer" }));
    expect(await screen.findByRole("dialog", { name: "Change proposal status" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(mocks.openTask).toHaveBeenCalledWith({
      contact: expect.objectContaining({ id: "l-1" }),
    });
  });

  it("a lost deal shows its reason and notes and offers Reopen", async () => {
    mocks.deal = baseDeal({ stage: "lost", lossReason: "price_budget", lossNotes: "Went cheaper" });
    await renderPage();
    expect(await screen.findByText("Lost: Price / Budget")).toBeTruthy();
    expect(screen.getByText("Went cheaper")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mark won/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Reopen/ }));
    expect(await screen.findByRole("dialog", { name: "Reopen deal" })).toBeTruthy();
  });

  it("404 → not found with a link back", async () => {
    mocks.deal = undefined;
    mocks.error = new BackendError(404, "not_found", "Deal not found.");
    await renderPage();
    expect(await screen.findByText("Deal not found")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to deals" })).toHaveAttribute("href", "/deals");
  });
});
