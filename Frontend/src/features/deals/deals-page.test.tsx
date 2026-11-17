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
import type { DealListItem, DealListParams, SavedView } from "@/types";

const mocks = vi.hoisted(() => ({
  listParams: [] as Array<{ params: unknown; enabled: boolean }>,
  countParams: [] as unknown[],
  boardProps: [] as unknown[],
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  createView: vi.fn(),
  openCreate: vi.fn(),
  views: [] as SavedView[],
}));

const row = (id: string, name: string, extra: Partial<DealListItem> = {}): DealListItem => ({
  id,
  name,
  stage: "proposal_sent",
  amount: 1_250_000,
  currency: "INR",
  expectedCloseDate: "2026-11-30",
  owner: { id: "u-1", name: "Asha Owner" },
  company: { id: "co-1", name: "Acme" },
  contact: { id: "l-1", name: "Ravi Kumar" },
  source: "manual",
  closedAt: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  ...extra,
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/add-lead-context", () => ({
  useCreateDealDialog: () => ({ open: mocks.openCreate }),
}));
vi.mock("./deal-board", () => ({
  DealBoard: (props: { params: DealListParams; showClosed: boolean }) => {
    mocks.boardProps.push(props);
    return <div>board {JSON.stringify(props.params)}</div>;
  },
}));
vi.mock("@/features/crm/record-peek", () => ({
  default: ({ id }: { id: string }) => <div>peek {id}</div>,
}));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => false,
  useSession: () => ({
    users: [{ id: "u-1", name: "Asha Owner", active: true }],
    userName: () => "Asha Owner",
  }),
  useUpdateDeal: () => ({ mutateAsync: vi.fn() }),
  useCompany: (id: string | undefined) => ({ data: id ? { id, name: "Acme" } : undefined }),
  useCompanySearch: () => ({ data: undefined }),
  useCreateCompany: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeals: (params: DealListParams, enabled: boolean) => {
    mocks.listParams.push({ params, enabled });
    return {
      data: {
        pages: [
          {
            data: [
              row("d-1", "Acme rollout"),
              row("d-2", "Bolt pilot", { amount: null, company: null }),
            ],
            nextCursor: null,
          },
        ],
      },
      hasNextPage: mocks.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: mocks.fetchNextPage,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useDealsCount: (params: DealListParams) => {
    mocks.countParams.push(params);
    return { data: { count: 2 } };
  },
  useSavedViews: () => ({ data: { data: mocks.views } }),
  useCreateSavedView: () => ({ mutateAsync: mocks.createView, isPending: false }),
  useUpdateSavedView: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSavedView: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { DealsPage } from "./deals-page";
import { currentIstMonth, validateDealsSearch } from "./deals-search";

async function renderPage(search: Record<string, unknown> = {}) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <div>at {path}</div> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/deals",
        validateSearch: validateDealsSearch,
        component: DealsPage,
      }),
      page("/deals/$dealId"),
      page("/companies/$companyId"),
      page("/contacts/$contactId"),
    ]),
    history: createMemoryHistory({ initialEntries: [`/deals${defaultStringifySearch(search)}`] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Deals" });
  return router;
}
const lastList = () => mocks.listParams[mocks.listParams.length - 1]!;
const searchOf = (router: Awaited<ReturnType<typeof renderPage>>) =>
  router.state.location.search as Record<string, unknown>;

beforeEach(() => {
  mocks.listParams = [];
  mocks.countParams = [];
  mocks.boardProps = [];
  mocks.views = [];
  mocks.hasNextPage = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("DealsPage", () => {
  it("reads filters and sort from the URL and sends them to GET /deals and /count", async () => {
    await renderPage({
      stage: ["negotiation"],
      ownerId: ["me"],
      status: "all",
      amountMin: "100000",
      companyId: "co-1",
      sort: "amount:desc",
      q: "ac",
    });
    expect(lastList()).toEqual({
      enabled: true,
      params: {
        stage: ["negotiation"],
        ownerId: ["me"],
        status: "all",
        amountMin: "100000",
        companyId: "co-1",
        sort: "amount:desc",
        q: "ac",
      },
    });
    expect(mocks.countParams.at(-1)).toMatchObject({ stage: ["negotiation"], q: "ac" });
    expect(screen.getByRole("button", { name: /Stage: Negotiation/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Amount: ≥ 100000/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Company filter" })).toHaveTextContent(
      "Company: Acme",
    );
    expect(screen.getByRole("columnheader", { name: /Amount/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    // Stage pill, money, links to company and contact.
    expect(screen.getAllByText("Proposal sent")).toHaveLength(2);
    expect(screen.getByText("₹12,50,000")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Acme" })[0]).toHaveAttribute(
      "href",
      "/companies/co-1",
    );
    expect(screen.getAllByRole("link", { name: "Ravi Kumar" })[0]).toHaveAttribute(
      "href",
      "/contacts/l-1",
    );
  });

  it("defaults to updated (newest first); sort only on whitelisted columns; filters write the URL", async () => {
    const router = await renderPage();
    expect(lastList().params).toEqual({ sort: "updatedAt:desc" });
    fireEvent.click(
      within(screen.getByRole("columnheader", { name: /Expected close/ })).getByRole("button"),
    );
    await waitFor(() => expect(searchOf(router)["sort"]).toBe("expectedCloseDate:asc"));
    expect(
      within(screen.getByRole("columnheader", { name: "Stage" })).queryByRole("button"),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Stage/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Negotiation" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(searchOf(router)["stage"]).toEqual(["negotiation"]));

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Won" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(searchOf(router)["status"]).toBe("won"));
  });

  it("views: My deals, Closing this month (current IST month), Won, Lost", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-10T10:00:00+05:30"));
    expect(currentIstMonth()).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    const router = await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "My deals" }));
    await waitFor(() => expect(searchOf(router)).toEqual({ view: "mine", ownerId: ["me"] }));
    fireEvent.click(screen.getByRole("tab", { name: "Closing this month" }));
    await waitFor(() =>
      expect(searchOf(router)).toEqual({
        view: "closing",
        expectedCloseFrom: "2026-02-01",
        expectedCloseTo: "2026-02-28",
      }),
    );
    expect(lastList().params).toMatchObject({
      expectedCloseFrom: "2026-02-01",
      expectedCloseTo: "2026-02-28",
    });
    fireEvent.click(screen.getByRole("tab", { name: "Won" }));
    await waitFor(() => expect(searchOf(router)).toEqual({ view: "won", status: "won" }));
    fireEvent.click(screen.getByRole("tab", { name: "Lost" }));
    await waitFor(() => expect(searchOf(router)).toEqual({ view: "lost", status: "lost" }));
  });

  it("loads more pages and opens a deal from a row", async () => {
    mocks.hasNextPage = true;
    const router = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mocks.fetchNextPage).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /Acme rollout/ })).toHaveAttribute(
      "href",
      "/deals/d-1",
    );
    // UX-2: a row click opens the peek drawer (the list stays); Back closes it.
    fireEvent.click(screen.getByText("Bolt pilot"));
    await waitFor(() =>
      expect((router.state.location.search as Record<string, unknown>)["peek"]).toBe("d-2"),
    );
    expect(await screen.findByText("peek d-2")).toBeInTheDocument();
    expect(router.state.location.pathname).not.toBe("/deals/d-2");
  });

  it("saves the current list as a deals view and reopens a saved one", async () => {
    mocks.createView.mockResolvedValue({ id: "v-new" });
    mocks.views = [
      {
        id: "v-1",
        object: "deals",
        name: "Big ones",
        filters: { amountMin: "1000000", stage: "negotiation" },
        sort: "amount:desc",
        columns: null,
        isShared: false,
        position: 0,
        ownerId: "u-1",
        isMine: true,
        createdAt: "",
        updatedAt: "",
      },
    ];
    const router = await renderPage({ ownerId: ["me"], sort: "name:asc" });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Mine A–Z" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.createView).toHaveBeenCalledWith({
        object: "deals",
        name: "Mine A–Z",
        isShared: false,
        filters: { ownerId: ["me"] },
        sort: "name:asc",
        columns: null,
        // After the existing views (positions 0…).
        position: 1,
      }),
    );
    await waitFor(() => expect(searchOf(router)["view"]).toBe("v-new"));
    // Five built-in views fill the tabs; saved ones sit under "More".
    fireEvent.pointerDown(screen.getByRole("button", { name: /More \(1\)/ }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Big ones" }));
    await waitFor(() =>
      expect(searchOf(router)).toEqual({
        view: "v-1",
        amountMin: "1000000",
        stage: ["negotiation"],
        sort: "amount:desc",
      }),
    );
  });

  it("layout switch: Board in the URL, shared filters without stage/sort, status from Show closed", async () => {
    const router = await renderPage({ ownerId: ["me"], stage: ["qualified"], sort: "name:asc" });
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    await waitFor(() => expect(searchOf(router)["layout"]).toBe("board"));
    expect(screen.queryByRole("table")).toBeNull();
    expect(mocks.boardProps.at(-1)).toMatchObject({
      params: { ownerId: ["me"], status: "open" },
      showClosed: false,
    });
    // The table list isn't fetched on the board; the count follows the board's filters.
    expect(lastList().enabled).toBe(false);
    expect(mocks.countParams.at(-1)).toEqual({ ownerId: ["me"], status: "open" });
    expect(screen.queryByRole("button", { name: /^Stage/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    await waitFor(() => expect(searchOf(router)["layout"]).toBeUndefined());
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("Create deal opens the app-wide dialog", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Create deal" }));
    expect(mocks.openCreate).toHaveBeenCalled();
  });
});
