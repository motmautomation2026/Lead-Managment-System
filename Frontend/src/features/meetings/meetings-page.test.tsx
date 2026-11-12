import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  defaultStringifySearch,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingListItem, MeetingListParams, SavedView } from "@/types";

const mocks = vi.hoisted(() => ({
  listParams: [] as MeetingListParams[],
  rows: [] as MeetingListItem[],
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  update: vi.fn(),
  outcome: vi.fn(),
  openSchedule: vi.fn(),
  views: [] as SavedView[],
  toast: { success: vi.fn(), error: vi.fn() },
}));

const meeting = (
  id: string,
  title: string,
  extra: Partial<MeetingListItem> = {},
): MeetingListItem => ({
  id,
  leadId: "l-1",
  dealId: "d-1",
  ownerId: "u-1",
  ownerName: "Asha Owner",
  title,
  at: "2026-10-28T05:30:00.000Z",
  durationMin: 30,
  status: "scheduled",
  meetLink: "https://meet.example.com/abc",
  calendarSyncStatus: "failed",
  calendarSyncError: "Calendar disconnected",
  notifyEmailStatus: "sent",
  notifyWhatsappStatus: "failed",
  notifyWhatsappError: "No WhatsApp number",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  contact: { id: "l-1", name: "Ravi Kumar" },
  company: { id: "co-1", name: "Acme" },
  deal: { id: "d-1", name: "Acme rollout" },
  ...extra,
});

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/app/add-lead-context", () => ({
  useScheduleMeetingDialog: () => ({ open: mocks.openSchedule }),
}));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => false,
  useSession: () => ({ users: [{ id: "u-1", name: "Asha Owner", active: true }] }),
  useCompany: (id: string | undefined) => ({ data: id ? { id, name: "Acme" } : undefined }),
  useCompanySearch: () => ({ data: undefined }),
  useCreateCompany: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useContact: (id: string) => ({
    data: id ? { id, firstName: "Ravi", lastName: "Kumar" } : undefined,
  }),
  useContactSearch: () => ({ data: undefined, isFetching: false, isError: false }),
  useDeal: (id: string | undefined) => ({ data: id ? { id, name: "Acme rollout" } : undefined }),
  useMeetingList: (params: MeetingListParams) => {
    mocks.listParams.push(params);
    return {
      data: { pages: [{ data: mocks.rows, nextCursor: null }] },
      hasNextPage: mocks.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: mocks.fetchNextPage,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useMeetingCount: (params: MeetingListParams) => ({
    data: { count: params.when === "needs_outcome" ? 4 : 7 },
  }),
  useUpdateMeeting: () => ({ mutateAsync: mocks.update, isPending: false }),
  useCreateMeeting: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRecordMeetingOutcome: () => ({ mutateAsync: mocks.outcome, isPending: false }),
  useSavedViews: () => ({ data: { data: mocks.views } }),
  useCreateSavedView: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateSavedView: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSavedView: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { MeetingsPage } from "./meetings-page";
import { validateMeetingsSearch } from "./meetings-search";

async function renderPage(search: Record<string, unknown> = {}) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <div>at {path}</div> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/meetings",
        validateSearch: validateMeetingsSearch,
        component: MeetingsPage,
      }),
      page("/contacts/$contactId"),
      page("/companies/$companyId"),
      page("/deals/$dealId"),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/meetings${defaultStringifySearch(search)}`],
    }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Meetings" });
  return router;
}
const lastList = () => mocks.listParams[mocks.listParams.length - 1]!;
const searchOf = (router: Awaited<ReturnType<typeof renderPage>>) =>
  router.state.location.search as Record<string, unknown>;

beforeEach(() => {
  mocks.listParams = [];
  mocks.views = [];
  mocks.hasNextPage = false;
  mocks.rows = [
    meeting("m-1", "Discovery call"),
    { ...meeting("m-2", "Demo", { status: "completed", outcome: "won" }), meetLink: "" },
  ];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("MeetingsPage", () => {
  it("defaults to Upcoming; Needs outcome shows its count; views and filters reach the API", async () => {
    const router = await renderPage();
    await waitFor(() => expect(searchOf(router)).toEqual({ view: "upcoming", when: "upcoming" }));
    expect(lastList()).toEqual({ when: "upcoming", sort: "at:asc", q: undefined });
    const tabs = screen.getByRole("tablist", { name: "Views" });
    fireEvent.click(within(tabs).getByRole("tab", { name: /^Needs outcome\s*4$/ }));
    await waitFor(() =>
      expect(lastList()).toMatchObject({ when: "needs_outcome", sort: "at:desc" }),
    );
    fireEvent.click(within(tabs).getByRole("tab", { name: "Cancelled" }));
    await waitFor(() => expect(lastList()).toMatchObject({ status: ["cancelled"] }));
    expect(lastList().when).toBeUndefined();
  });

  it("reads owner, status, date range, contact, company and deal from the URL", async () => {
    const router = await renderPage({
      ownerId: ["me"],
      status: ["confirmed"],
      from: "2026-10-01T00:00:00+05:30",
      to: "2026-10-31T23:59:59+05:30",
      contactId: "l-1",
      companyId: "co-1",
      dealId: "d-1",
    });
    expect(lastList()).toEqual({
      ownerId: ["me"],
      status: ["confirmed"],
      from: "2026-10-01T00:00:00+05:30",
      to: "2026-10-31T23:59:59+05:30",
      contactId: "l-1",
      companyId: "co-1",
      dealId: "d-1",
      q: undefined,
      sort: "at:asc",
    });
    expect(screen.getByText("Deal: Acme rollout")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear deal filter" }));
    await waitFor(() => expect(searchOf(router)["dealId"]).toBeUndefined());
  });

  it("shows sync and notify statuses with their errors, and a Join link", async () => {
    await renderPage({ view: "upcoming", when: "upcoming" });
    const row = screen.getByText("Discovery call").closest("tr")!;
    expect(
      within(row).getByRole("img", { name: "Calendar: Failed — Calendar disconnected" }),
    ).toBeTruthy();
    expect(within(row).getByText("Email: Sent")).toBeTruthy();
    expect(
      within(row).getByRole("img", { name: "WhatsApp: Failed — No WhatsApp number" }),
    ).toHaveAttribute("title", "WhatsApp: Failed — No WhatsApp number");
    expect(within(row).getByRole("link", { name: "Join Discovery call" })).toHaveAttribute(
      "href",
      "https://meet.example.com/abc",
    );
  });

  it("row Sheet: record outcome, cancel with a confirm, reschedule; completed meetings can't get another outcome", async () => {
    mocks.outcome.mockResolvedValue({});
    mocks.update.mockResolvedValue({});
    await renderPage({ view: "upcoming", when: "upcoming" });
    fireEvent.click(screen.getByText("Discovery call"));
    let sheet = await screen.findByRole("dialog", { name: "Discovery call" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Record outcome" }));
    const outcome = await screen.findByRole("dialog", { name: "Record meeting outcome" });
    fireEvent.click(within(outcome).getByRole("button", { name: "Save outcome" }));
    await waitFor(() =>
      expect(mocks.outcome).toHaveBeenCalledWith({
        id: "m-1",
        outcome: "proposal_required",
        notes: undefined,
      }),
    );

    fireEvent.click(screen.getByText("Discovery call"));
    sheet = await screen.findByRole("dialog", { name: "Discovery call" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel meeting" }));
    const confirm = await screen.findByRole("dialog", { name: "Cancel meeting" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel meeting" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ id: "m-1", input: { status: "cancelled" } }),
    );

    fireEvent.click(screen.getByText("Discovery call"));
    sheet = await screen.findByRole("dialog", { name: "Discovery call" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Edit / reschedule" }));
    expect(await screen.findByRole("dialog", { name: "Reschedule meeting" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Reschedule meeting" }), {
      key: "Escape",
    });

    fireEvent.click(screen.getByText("Demo"));
    sheet = await screen.findByRole("dialog", { name: "Demo" });
    expect(within(sheet).queryByRole("button", { name: "Record outcome" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Edit / reschedule" })).toBeNull();
  });

  it("Schedule meeting opens the shared dialog; empty view has a next action", async () => {
    mocks.rows = [];
    await renderPage({ view: "today", when: "today" });
    expect(screen.getByText("No meetings today.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Schedule meeting" })[0]!);
    expect(mocks.openSchedule).toHaveBeenCalled();
  });

  it("at phone width rows are cards (date, title, contact, status) with Load more", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    mocks.hasNextPage = true;
    await renderPage({ view: "upcoming", when: "upcoming" });
    expect(screen.queryByRole("table")).toBeNull();
    const cards = within(screen.getByRole("list", { name: "Meetings" })).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("Discovery call");
    expect(cards[0]).toHaveTextContent("Ravi Kumar");
    expect(cards[0]).toHaveTextContent("Scheduled");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mocks.fetchNextPage).toHaveBeenCalled();
    fireEvent.click(within(cards[0]!).getByRole("button"));
    expect(await screen.findByRole("dialog", { name: "Discovery call" })).toBeTruthy();
  });
});

describe("MeetingsPage — UX-2 row action", () => {
  it("Needs outcome rows record the outcome in one click; other views don't show the button", async () => {
    mocks.outcome.mockResolvedValue({});
    await renderPage({ view: "upcoming", when: "upcoming" });
    expect(screen.queryByRole("button", { name: "Record outcome" })).toBeNull();
    cleanup();
    await renderPage({ view: "needs_outcome", when: "needs_outcome" });
    fireEvent.click(screen.getByRole("button", { name: "Record outcome" }));
    const outcome = await screen.findByRole("dialog", { name: "Record meeting outcome" });
    fireEvent.click(within(outcome).getByRole("button", { name: "Save outcome" }));
    await waitFor(() =>
      expect(mocks.outcome).toHaveBeenCalledWith({
        id: "m-1",
        outcome: "proposal_required",
        notes: undefined,
      }),
    );
  });
});
