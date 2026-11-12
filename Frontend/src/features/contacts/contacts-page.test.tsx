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
import type { ContactListItem, ContactListParams, SavedView } from "@/types";

const mocks = vi.hoisted(() => ({
  isAdmin: false,
  listParams: [] as unknown[],
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  bulk: vi.fn(),
  createView: vi.fn(),
  updateView: vi.fn(),
  deleteView: vi.fn(),
  views: [] as SavedView[],
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const row = (id: string, name: string): ContactListItem => ({
  id,
  name,
  firstName: name.split(" ")[0]!,
  lastName: name.split(" ")[1] ?? "",
  email: `${id}@example.com`,
  phone: null,
  jobTitle: null,
  source: "website",
  company: { id: "co-1", name: "Acme" },
  owner: null,
  leadStatus: "new",
  lifecycle: "active",
  openDeal: null,
  agentStatus: "none",
  nextAction: null,
  lastActivityAt: "2026-10-20T10:00:00.000Z",
  createdAt: "2026-10-01T10:00:00.000Z",
});

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/features/leads/import-leads-dialog", () => ({ ImportLeadsDialog: () => null }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
  useSession: () => ({
    users: [
      { id: "u-1", name: "Asha Owner", active: true },
      { id: "u-2", name: "Ravi Owner", active: true },
    ],
  }),
  useContacts: (params: ContactListParams) => {
    mocks.listParams.push(params);
    return {
      data: {
        pages: [{ data: [row("c-1", "Mira Rao"), row("c-2", "Dev Shah")], nextCursor: null }],
      },
      hasNextPage: mocks.hasNextPage,
      isFetchingNextPage: false,
      fetchNextPage: mocks.fetchNextPage,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useContactsCount: () => ({ data: { count: 2 } }),
  useBulkContacts: () => ({ mutateAsync: mocks.bulk, isPending: false }),
  useCompany: (id?: string) => ({ data: id ? { id, name: "Acme" } : undefined }),
  useCompanySearch: () => ({ data: undefined, isFetching: false }),
  useCreateCompany: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSavedViews: () => ({ data: { data: mocks.views } }),
  useCreateSavedView: () => ({ mutateAsync: mocks.createView, isPending: false }),
  useUpdateSavedView: () => ({ mutateAsync: mocks.updateView, isPending: false }),
  useDeleteSavedView: () => ({ mutateAsync: mocks.deleteView, isPending: false }),
}));

import { ContactsPage } from "./contacts-page";
import { validateContactsSearch } from "./contacts-search";

async function renderPage(search: Record<string, unknown> = {}) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/contacts",
        validateSearch: validateContactsSearch,
        component: ContactsPage,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/contacts/$contactId",
        component: () => null,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/companies/$companyId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/contacts${defaultStringifySearch(search)}`],
    }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Contacts" });
  return router;
}
const lastParams = () => mocks.listParams[mocks.listParams.length - 1];
const searchOf = (router: Awaited<ReturnType<typeof renderPage>>) =>
  router.state.location.search as Record<string, unknown>;
const openMenu = (name: string | RegExp) =>
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });

beforeEach(() => {
  mocks.listParams = [];
  mocks.views = [];
  mocks.hasNextPage = false;
  mocks.isAdmin = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ContactsPage", () => {
  it("reads filters and sort from the URL and sends them to GET /contacts", async () => {
    await renderPage({ ownerId: ["me"], hasOpenDeal: "false", sort: "name:asc", q: "ra" });
    expect(lastParams()).toEqual({
      ownerId: ["me"],
      hasOpenDeal: "false",
      sort: "name:asc",
      q: "ra",
    });
    expect(screen.getByRole("button", { name: /Owner: Me/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open deal: No open deal/ })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("a one-character search is not sent (the API needs 2)", async () => {
    await renderPage({ q: "r" });
    expect(lastParams()).toEqual({ sort: "createdAt:desc" });
  });

  it("filters, sort and views write the URL; a view replaces the filters", async () => {
    const router = await renderPage({ source: ["website"] });
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    await waitFor(() => expect(searchOf(router)["sort"]).toBe("name:asc"));
    // Not sortable on the API: no sort button.
    expect(screen.queryByRole("button", { name: /^Email/ })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Unassigned" }));
    await waitFor(() =>
      expect(searchOf(router)).toEqual({ view: "unassigned", ownerId: ["none"] }),
    );
    expect(lastParams()).toMatchObject({ ownerId: ["none"] });

    fireEvent.click(screen.getByRole("tab", { name: "All contacts" }));
    await waitFor(() => expect(searchOf(router)).toEqual({}));

    fireEvent.click(screen.getByRole("button", { name: /Lead status/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "New" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(searchOf(router)["leadStatus"]).toEqual(["new"]));
  });

  it("the company filter is a CompanyPicker chip; clearing it drops companyId", async () => {
    const router = await renderPage({ companyId: "co-1" });
    expect(lastParams()).toMatchObject({ companyId: "co-1" });
    expect(screen.getByRole("button", { name: "Company filter" })).toHaveTextContent(
      "Company: Acme",
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear company filter" }));
    await waitFor(() => expect(searchOf(router)["companyId"]).toBeUndefined());
  });

  it("the Company column opens the company, not the contact", async () => {
    const router = await renderPage();
    const link = screen.getAllByRole("link", { name: "Acme" })[0]!;
    expect(link).toHaveAttribute("href", "/companies/co-1");
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/companies/co-1"));
  });

  it("loads more pages", async () => {
    mocks.hasNextPage = true;
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mocks.fetchNextPage).toHaveBeenCalled();
  });

  it("bulk assign owner reports per-contact failures", async () => {
    mocks.bulk.mockResolvedValue([
      { id: "c-1", ok: true },
      { id: "c-2", ok: false, error: "Contact not found." },
    ]);
    await renderPage();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all loaded rows" }));
    const bar = screen.getByRole("toolbar", { name: "Bulk actions" });
    expect(within(bar).queryByRole("button", { name: /Enroll in AI/ })).toBeNull();
    fireEvent.keyDown(within(bar).getByRole("button", { name: /Assign owner/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ravi Owner" }));
    await waitFor(() =>
      expect(mocks.bulk).toHaveBeenCalledWith({
        ids: ["c-1", "c-2"],
        action: "assignOwner",
        ownerId: "u-2",
      }),
    );
    await waitFor(() =>
      expect(mocks.toast.warning).toHaveBeenCalledWith("1 of 2 assigned; 1 not", {
        description: "Dev Shah: Contact not found.",
      }),
    );
  });

  it("admins can enroll the selection in AI", async () => {
    mocks.isAdmin = true;
    mocks.bulk.mockResolvedValue([{ id: "c-1", ok: true }]);
    await renderPage();
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Select row" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: /Enroll in AI/ }));
    await waitFor(() =>
      expect(mocks.bulk).toHaveBeenCalledWith({ ids: ["c-1"], action: "enrollAi" }),
    );
    expect(mocks.toast.success).toHaveBeenCalledWith("1 contact enrolled in AI");
  });

  it("saves the current list as a view and opens it", async () => {
    mocks.createView.mockResolvedValue({ id: "v-new" });
    const router = await renderPage({ ownerId: ["me"], sort: "name:asc" });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Mine by name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.createView).toHaveBeenCalledWith({
        object: "contacts",
        name: "Mine by name",
        isShared: false,
        filters: { ownerId: ["me"] },
        sort: "name:asc",
        columns: null,
        position: 0,
      }),
    );
    await waitFor(() => expect(searchOf(router)["view"]).toBe("v-new"));
  });

  it("opens a saved view, renames it and deletes it; shared views are marked", async () => {
    const view: SavedView = {
      id: "v-1",
      object: "contacts",
      name: "Hot",
      filters: { leadStatus: "new" },
      sort: "lastActivityAt:desc",
      columns: ["name", "email"],
      isShared: false,
      position: 0,
      ownerId: "u-1",
      isMine: true,
      createdAt: "",
      updatedAt: "",
    };
    mocks.views = [
      view,
      { ...view, id: "v-2", name: "Team", isShared: true, isMine: false, ownerId: "u-2" },
    ];
    mocks.updateView.mockResolvedValue(view);
    mocks.deleteView.mockResolvedValue(undefined);
    const router = await renderPage();
    // Six views: the sixth is in "More".
    openMenu("More (1)");
    expect(await screen.findByRole("menuitem", { name: "Team · Shared" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(screen.getByRole("tab", { name: "Hot" }));
    await waitFor(() =>
      expect(searchOf(router)).toEqual({
        view: "v-1",
        leadStatus: ["new"],
        sort: "lastActivityAt:desc",
        columns: ["name", "email"],
      }),
    );

    openMenu("View options");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage views…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename Hot" }));
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Hotter" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(mocks.updateView).toHaveBeenCalledWith({ id: "v-1", input: { name: "Hotter" } }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete Hot" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    await waitFor(() => expect(mocks.deleteView).toHaveBeenCalledWith("v-1"));
    await waitFor(() => expect(searchOf(router)).toEqual({}));
  });

  it("someone else's shared view has no rename/delete for a salesperson", async () => {
    mocks.views = [
      {
        id: "v-2",
        object: "contacts",
        name: "Team",
        filters: {},
        sort: null,
        columns: null,
        isShared: true,
        position: 0,
        ownerId: "u-2",
        isMine: false,
        createdAt: "",
        updatedAt: "",
      },
    ];
    await renderPage({ view: "v-2" });
    openMenu("View options");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage views…" }));
    expect(await screen.findByText("Shared by a teammate")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename Team" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Team" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reorder Team" })).toBeNull();
  });
});

describe("ContactsPage — UX-2 list standard", () => {
  beforeEach(() => window.localStorage.clear());

  it("remembers rows per page and columns in this browser; the URL keeps filters and Back works", async () => {
    const router = await renderPage({ ownerId: ["me"] });
    fireEvent.keyDown(screen.getByLabelText("Rows per page"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "100 per page" }));
    await waitFor(() => expect(lastParams()).toMatchObject({ limit: 100, ownerId: ["me"] }));

    openMenu("Columns");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Source" }));
    await waitFor(() => expect(searchOf(router)["columns"]).toContain("source"));
    const columns = searchOf(router)["columns"];

    // Back restores the URL before the column change; the filter stays.
    router.history.back();
    await waitFor(() => expect(searchOf(router)["columns"]).toBeUndefined());
    expect(searchOf(router)["ownerId"]).toEqual(["me"]);

    // A fresh visit without columns in the URL uses the remembered page size and columns.
    cleanup();
    await renderPage({});
    expect(lastParams()).toMatchObject({ limit: 100 });
    expect(screen.getByRole("columnheader", { name: "Source" })).toBeInTheDocument();
    expect(columns).toContain("source");
  });
});
