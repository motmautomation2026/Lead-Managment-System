import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  defaultStringifySearch,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const calls: Array<[string, unknown]> = [];
  const fetchNextPage = vi.fn();
  const list =
    (kind: string, rows: object[], hasNextPage = false) =>
    (params: unknown) => {
      calls.push([kind, params]);
      return {
        data: { pages: [{ data: rows, nextCursor: hasNextPage ? "next" : null }] },
        hasNextPage,
        isFetchingNextPage: false,
        fetchNextPage,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      };
    };
  const count = (kind: string, n: number) => (params: unknown) => {
    calls.push([`${kind}Count`, params]);
    return { data: { count: n } };
  };
  return { calls, fetchNextPage, list, count };
});
vi.mock("@/store", () => ({
  messageFromError: () => "Failed",
  useContacts: mocks.list("contacts", [
    {
      id: "c-1",
      name: "Asha Rao",
      firstName: "Asha",
      lastName: "Rao",
      email: "asha@tata.test",
      phone: "",
      company: { id: "co-1", name: "Tata Motors" },
      owner: null,
      leadStatus: "new",
      lifecycle: "active",
      openDeal: null,
      nextAction: null,
      lastActivityAt: null,
      createdAt: "2026-10-01T10:00:00.000Z",
    },
  ]),
  useContactsCount: mocks.count("contacts", 1),
  useCompanies: mocks.list(
    "companies",
    [
      {
        id: "co-1",
        name: "Tata Motors",
        domain: "tata.test",
        industry: null,
        city: null,
        owner: null,
        contactCount: 1,
        openDealCount: 0,
        openDealAmount: 0,
        createdAt: "2026-10-01T10:00:00.000Z",
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
    ],
    true,
  ),
  useCompaniesCount: mocks.count("companies", 51),
  useDeals: mocks.list("deals", []),
  useDealsCount: mocks.count("deals", 0),
}));

import { SearchPage } from "./search-page";
import { validateSearchPage } from "./search-schema";

async function renderPage(search: Record<string, unknown> = {}) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <div>at {path}</div> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/search",
        validateSearch: validateSearchPage,
        component: SearchPage,
      }),
      page("/contacts"),
      page("/companies"),
      page("/deals"),
      page("/contacts/$contactId"),
    ]),
    history: createMemoryHistory({ initialEntries: [`/search${defaultStringifySearch(search)}`] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Search" });
  return router;
}

afterEach(() => {
  cleanup();
  mocks.calls.length = 0;
  vi.clearAllMocks();
});

describe("SearchPage", () => {
  it("below 2 characters: a hint, no list requests", async () => {
    await renderPage({ q: "t" });
    expect(screen.getByText(/Type at least 2 characters/)).toBeTruthy();
    expect(mocks.calls).toEqual([]);
  });

  it("tabs with counts from /count; each tab lists its object with q (same scope as the palette)", async () => {
    const router = await renderPage({ q: "tata" });
    expect(screen.getByRole("tab", { name: "Contacts · 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Companies · 51" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Deals · 0" })).toBeTruthy();
    expect(mocks.calls).toContainEqual(["contacts", { q: "tata", lifecycle: ["all"] }]);
    expect(mocks.calls).toContainEqual(["companiesCount", { q: "tata" }]);
    expect(mocks.calls).toContainEqual(["dealsCount", { q: "tata", status: "all" }]);
    expect(screen.getByText("Asha Rao")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Deals · 0" }));
    expect(await screen.findByText("No deals match “tata”")).toBeTruthy();
    expect(router.state.location.search).toEqual({ q: "tata", tab: "deals" });
  });

  it("load more pages the active tab", async () => {
    await renderPage({ q: "tata", tab: "companies" });
    expect(screen.getByText("tata.test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mocks.fetchNextPage).toHaveBeenCalled();
  });

  it("typing writes q to the URL after 300 ms (replace); Open in list carries q", async () => {
    const router = await renderPage({ q: "tata" });
    const before = router.history.length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), {
      target: { value: "asha" },
    });
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "asha" }));
    expect(router.history.length).toBe(before);
    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Open in Contacts list" }));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/contacts"));
    expect(router.state.location.search).toEqual({ q: "asha", lifecycle: ["all"] });
  });
});
