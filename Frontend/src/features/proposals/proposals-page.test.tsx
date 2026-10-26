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
import type { ProposalListItem, ProposalListParams, SavedView } from "@/types";

const mocks = vi.hoisted(() => ({
  listParams: [] as ProposalListParams[],
  summaryParams: [] as ProposalListParams[],
  rows: [] as ProposalListItem[],
  setStatus: vi.fn(),
  create: vi.fn(),
  views: [] as SavedView[],
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const proposal = (
  id: string,
  title: string,
  extra: Partial<ProposalListItem> = {},
): ProposalListItem => ({
  id,
  leadId: "l-1",
  dealId: null,
  ownerId: "u-1",
  ownerName: "Asha Owner",
  title,
  fileName: "proposal.pdf",
  amount: 1_250_000,
  currency: "INR",
  status: "sent",
  sentDate: "2026-10-20T10:00:00.000Z",
  emailSendStatus: "sent",
  whatsappSendStatus: "sent",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  contact: { id: "l-1", name: "Ravi Kumar" },
  company: { id: "co-1", name: "Acme" },
  deal: null,
  allowedNextStatuses: ["accepted", "rejected", "expired"],
  lossReasonStatuses: ["rejected", "expired"],
  ...extra,
});

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => false,
  useSession: () => ({ users: [{ id: "u-1", name: "Asha Owner", active: true }] }),
  useAutomations: () => ({ templates: [] }),
  useCompany: (id: string | undefined) => ({ data: id ? { id, name: "Acme" } : undefined }),
  useCompanySearch: () => ({ data: undefined }),
  useCreateCompany: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useContact: (id: string) => ({
    data: id ? { id, firstName: "Ravi", lastName: "Kumar" } : undefined,
  }),
  useContactSearch: () => ({ data: undefined, isFetching: false, isError: false }),
  useDeal: () => ({ data: undefined }),
  useProposalList: (params: ProposalListParams) => {
    mocks.listParams.push(params);
    return {
      data: { pages: [{ data: mocks.rows, nextCursor: null }] },
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useProposalCount: () => ({ data: { count: 2 } }),
  useProposalSummary: (params: ProposalListParams) => {
    mocks.summaryParams.push(params);
    return { data: { openCount: 3, sentCount: 1, openValue: 3_500_000 } };
  },
  useCreateProposal: () => ({ mutateAsync: mocks.create }),
  useSetProposalStatus: () => ({ mutateAsync: mocks.setStatus }),
  useSavedViews: () => ({ data: { data: mocks.views } }),
  useCreateSavedView: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateSavedView: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSavedView: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { ProposalsPage } from "./proposals-page";
import { validateProposalsSearch } from "./proposals-search";

async function renderPage(search: Record<string, unknown> = {}) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <div>at {path}</div> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/proposals",
        validateSearch: validateProposalsSearch,
        component: ProposalsPage,
      }),
      page("/contacts/$contactId"),
      page("/companies/$companyId"),
      page("/deals/$dealId"),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/proposals${defaultStringifySearch(search)}`],
    }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Proposals" });
  return router;
}
const lastList = () => mocks.listParams[mocks.listParams.length - 1]!;
const searchOf = (router: Awaited<ReturnType<typeof renderPage>>) =>
  router.state.location.search as Record<string, unknown>;

beforeEach(() => {
  mocks.listParams = [];
  mocks.summaryParams = [];
  mocks.views = [];
  mocks.rows = [
    proposal("p-1", "Fleet proposal"),
    proposal("p-2", "Old deal", {
      status: "accepted",
      allowedNextStatuses: [],
      lossReasonStatuses: [],
    }),
  ];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("ProposalsPage", () => {
  it("defaults to Open; header stats come from the summary; views use backend groups", async () => {
    const router = await renderPage({});
    await waitFor(() => expect(searchOf(router)).toEqual({ view: "open", group: "open" }));
    expect(lastList()).toEqual({ group: "open", sort: "updatedAt:desc", q: undefined });
    const stats = screen.getByLabelText("Proposal summary");
    expect(stats).toHaveTextContent("Open3");
    expect(stats).toHaveTextContent("Sent1");
    expect(stats).toHaveTextContent("₹35.0 L");
    // Stats keep the page's filters but not group/status.
    expect(mocks.summaryParams.at(-1)).toEqual({ q: undefined });

    const tabs = screen.getByRole("tablist", { name: "Views" });
    fireEvent.click(within(tabs).getByRole("tab", { name: "Lost" }));
    await waitFor(() => expect(lastList()).toMatchObject({ group: "lost" }));
    fireEvent.click(within(tabs).getByRole("tab", { name: "Awaiting decision" }));
    await waitFor(() => expect(lastList()).toMatchObject({ group: "awaiting_decision" }));
  });

  it("reads owner, status, contact, company and updated range from the URL", async () => {
    await renderPage({
      ownerId: ["me"],
      status: ["sent", "revised"],
      contactId: "l-1",
      companyId: "co-1",
      updatedFrom: "2026-10-01T00:00:00+05:30",
      sort: "amount:desc",
    });
    expect(lastList()).toEqual({
      ownerId: ["me"],
      status: ["sent", "revised"],
      contactId: "l-1",
      companyId: "co-1",
      updatedFrom: "2026-10-01T00:00:00+05:30",
      q: undefined,
      sort: "amount:desc",
    });
    expect(mocks.summaryParams.at(-1)).toEqual({
      ownerId: ["me"],
      contactId: "l-1",
      companyId: "co-1",
      updatedFrom: "2026-10-01T00:00:00+05:30",
      q: undefined,
    });
  });

  it("row Sheet → Change status: Rejected needs a reason (B4); a final status offers nothing", async () => {
    mocks.setStatus.mockResolvedValue({});
    await renderPage({ view: "open", group: "open" });
    fireEvent.click(screen.getByText("Fleet proposal"));
    const sheet = await screen.findByRole("dialog", { name: "Fleet proposal" });
    expect(within(sheet).getByText("proposal.pdf")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Change status" }));
    const dialog = await screen.findByRole("dialog", { name: "Change proposal status" });
    fireEvent.keyDown(within(dialog).getByLabelText("New status"), { key: "Enter" });
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Accepted", "Rejected", "Expired"]);
    fireEvent.click(screen.getByRole("option", { name: "Rejected" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save status" }));
    expect(await within(dialog).findByText("Pick a loss reason.")).toBeTruthy();
    fireEvent.keyDown(within(dialog).getByLabelText("Loss reason"), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "No Urgency" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save status" }));
    await waitFor(() =>
      expect(mocks.setStatus).toHaveBeenCalledWith({
        id: "p-1",
        status: "rejected",
        lossReason: "no_urgency",
        lossNotes: undefined,
      }),
    );
  });

  it("a WhatsApp send stuck over 2 minutes says 'Still sending — check later' (B19)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T10:00:00Z"));
    mocks.rows = [
      proposal("p-3", "Stuck", {
        whatsappSendStatus: "sending",
        updatedAt: "2026-10-26T09:57:00Z",
      }),
      proposal("p-4", "Fresh", {
        whatsappSendStatus: "sending",
        updatedAt: "2026-10-26T09:59:30Z",
      }),
    ];
    await renderPage({ view: "open", group: "open" });
    expect(screen.getByText("Stuck").closest("tr")).toHaveTextContent(
      "Still sending — check later",
    );
    expect(screen.getByText("Fresh").closest("tr")).not.toHaveTextContent("Still sending");
  });

  it("New proposal opens Send proposal with a contact picker", async () => {
    await renderPage({ view: "open", group: "open" });
    fireEvent.click(screen.getAllByRole("button", { name: "New proposal" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Send proposal" });
    expect(within(dialog).getByRole("button", { name: "Contact" })).toBeTruthy();
  });
});
