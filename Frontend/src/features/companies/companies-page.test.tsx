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
import type { CompanyListItem, CompanyListParams, SavedView } from "@/types";

const mocks = vi.hoisted(() => ({
  isAdmin: false,
  listParams: [] as unknown[],
  countParams: [] as unknown[],
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  createView: vi.fn(),
  openCreate: vi.fn(),
  views: [] as SavedView[],
  duplicatesEnabled: [] as boolean[],
  updateCompany: vi.fn(async (_id: string, _input: unknown) => ({})),
  toast: { success: vi.fn(), error: vi.fn() },
}));

const row = (id: string, name: string, extra: Partial<CompanyListItem> = {}): CompanyListItem => ({
  id,
  name,
  domain: `${id}.example.com`,
  industry: "Steel",
  city: "Pune",
  owner: { id: "u-1", name: "Asha Owner" },
  contactCount: 3,
  openDealCount: 2,
  openDealAmount: 1_500_000,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  ...extra,
});

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/backend-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend-client")>()),
  backend: { companies: { update: mocks.updateCompany } },
}));
vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/app/add-lead-context", () => ({
  useCreateCompanyDialog: () => ({ open: mocks.openCreate }),
}));
vi.mock("@/features/crm/record-peek", () => ({
  default: ({ id }: { id: string }) => <div>peek {id}</div>,
}));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
  useSession: () => ({
    users: [
      { id: "u-1", name: "Asha Owner", active: true },
      { id: "u-2", name: "Ravi Rep", active: true },
    ],
    userName: (id: string) => (id === "u-2" ? "Ravi Rep" : "Asha Owner"),
  }),
  useUpdateCompany: () => ({
    mutateAsync: ({ id, input }: { id: string; input: unknown }) => mocks.updateCompany(id, input),
  }),
  useCompanies: (params: CompanyListParams) => {
    mocks.listParams.push(params);
    return {
      data: {
        pages: [
          {
            data: [row("co-1", "Acme"), row("co-2", "Bolt", { openDealCount: 0 })],
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
  useCompaniesCount: (params: CompanyListParams) => {
    mocks.countParams.push(params);
    return { data: { count: 2 } };
  },
  useCompanyIndustries: () => ({ data: { data: ["Retail", "Steel"] } }),
  useCompanyDuplicatesCount: (_params: unknown, enabled: boolean) => {
    mocks.duplicatesEnabled.push(enabled);
    return { data: enabled ? { count: 4 } : undefined };
  },
  useSavedViews: () => ({ data: { data: mocks.views } }),
  useCreateSavedView: () => ({ mutateAsync: mocks.createView, isPending: false }),
  useUpdateSavedView: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSavedView: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { CompaniesPage } from "./companies-page";
import { validateCompaniesSearch } from "./companies-search";

async function renderPage(search: Record<string, unknown> = {}) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/companies",
        validateSearch: validateCompaniesSearch,
        component: CompaniesPage,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/companies/duplicates",
        component: () => <div>dupes</div>,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/companies/$companyId",
        component: () => <div>record</div>,
      }),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/companies${defaultStringifySearch(search)}`],
    }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Companies" });
  return router;
}
const lastParams = () => mocks.listParams[mocks.listParams.length - 1];
const searchOf = (router: Awaited<ReturnType<typeof renderPage>>) =>
  router.state.location.search as Record<string, unknown>;

beforeEach(() => {
  mocks.listParams = [];
  mocks.countParams = [];
  mocks.views = [];
  mocks.hasNextPage = false;
  mocks.isAdmin = false;
  mocks.duplicatesEnabled = [];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CompaniesPage", () => {
  it("UX-3 bulk Assign owner: one PATCH per company, no confirm up to 20, Undo restores each owner", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all loaded rows" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: /Assign owner/ }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ravi Rep" }));
    await waitFor(() => expect(mocks.updateCompany).toHaveBeenCalledTimes(2));
    expect(mocks.updateCompany).toHaveBeenCalledWith("co-1", { ownerId: "u-2" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled());
    const [message, options] = mocks.toast.success.mock.calls.at(-1) as [
      string,
      { action: { onClick: () => void } },
    ];
    expect(message).toBe("2 companies assigned to Ravi Rep");
    options.action.onClick();
    await waitFor(() =>
      expect(mocks.updateCompany).toHaveBeenCalledWith("co-2", { ownerId: "u-1" }),
    );
  });

  it("reads filters and sort from the URL and sends them to GET /companies", async () => {
    await renderPage({
      industry: ["Steel"],
      hasDomain: "true",
      sort: "contactCount:desc",
      q: "ac",
    });
    expect(lastParams()).toEqual({
      industry: ["Steel"],
      hasDomain: "true",
      sort: "contactCount:desc",
      q: "ac",
    });
    expect(mocks.countParams.at(-1)).toMatchObject({ industry: ["Steel"], q: "ac" });
    expect(screen.getByRole("button", { name: /Industry: Steel/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Domain: Has a domain/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Contacts/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    // Open deals: count + INR total; none → dash.
    expect(screen.getAllByText(/^₹15(\.0)? L$/)).toHaveLength(1);
  });

  it("defaults to name A–Z; sort, filters and views write the URL", async () => {
    const router = await renderPage();
    expect(lastParams()).toEqual({ sort: "name:asc" });
    fireEvent.click(screen.getByRole("button", { name: /Updated/ }));
    await waitFor(() => expect(searchOf(router)["sort"]).toBe("updatedAt:asc"));
    expect(
      within(screen.getByRole("columnheader", { name: "Domain" })).queryByRole("button"),
    ).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "My companies" }));
    await waitFor(() => expect(searchOf(router)).toEqual({ view: "mine", ownerId: ["me"] }));

    fireEvent.click(screen.getByRole("button", { name: /^Industry/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Retail" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(searchOf(router)["industry"]).toEqual(["Retail"]));
  });

  it("loads more pages and opens a record from a row", async () => {
    mocks.hasNextPage = true;
    const router = await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mocks.fetchNextPage).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /Acme/ })).toHaveAttribute("href", "/companies/co-1");
    // UX-2: a row click opens the peek drawer (the list stays); Back closes it.
    fireEvent.click(screen.getByText("Bolt"));
    await waitFor(() =>
      expect((router.state.location.search as Record<string, unknown>)["peek"]).toBe("co-2"),
    );
    expect(await screen.findByText("peek co-2")).toBeInTheDocument();
    expect(router.state.location.pathname).not.toBe("/companies/co-2");
  });

  it("saves the current list as a companies view", async () => {
    mocks.createView.mockResolvedValue({ id: "v-new" });
    const router = await renderPage({ industry: ["Steel"], sort: "name:desc" });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Steel" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.createView).toHaveBeenCalledWith({
        object: "companies",
        name: "Steel",
        isShared: false,
        filters: { industry: ["Steel"] },
        sort: "name:desc",
        columns: null,
        position: 0,
      }),
    );
    await waitFor(() => expect(searchOf(router)["view"]).toBe("v-new"));
  });

  it("opens a saved view (a single stored value becomes a list)", async () => {
    mocks.views = [
      {
        id: "v-1",
        object: "companies",
        name: "Retail",
        filters: { industry: "Retail" },
        sort: "createdAt:desc",
        columns: ["name", "industry"],
        isShared: true,
        position: 0,
        ownerId: "u-2",
        isMine: false,
        createdAt: "",
        updatedAt: "",
      },
    ];
    const router = await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "Retail · Shared" }));
    await waitFor(() =>
      expect(searchOf(router)).toEqual({
        view: "v-1",
        industry: ["Retail"],
        sort: "createdAt:desc",
        columns: ["name", "industry"],
      }),
    );
    // Someone else's view: no Save, only Save as new once edited.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("Create company opens the dialog; duplicates button only for admins", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Create company" }));
    expect(mocks.openCreate).toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /Review duplicates/ })).toBeNull();
    expect(mocks.duplicatesEnabled.every((e) => e === false)).toBe(true);
    cleanup();

    mocks.isAdmin = true;
    const router = await renderPage();
    const link = screen.getByRole("link", { name: /Review duplicates \(4 open\)/ });
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/companies/duplicates"));
  });
});
