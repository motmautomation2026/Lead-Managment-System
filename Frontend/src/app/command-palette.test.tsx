import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResults } from "@/types/search";

const mocks = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class extends Error {},
  backend: { search: mocks.search },
}));

import { CommandPalette } from "@/app/command-palette";
import { keys } from "@/store/query";

const RESULTS: SearchResults = {
  contacts: [
    {
      id: "c1",
      name: "Asha Rao",
      email: "asha@tata.test",
      company: "Tata Motors",
      lifecycle: "active",
    },
  ],
  companies: [{ id: "co1", name: "Tata Motors", domain: "tata.test" }],
  deals: [
    {
      id: "d1",
      name: "Tata fleet deal",
      stage: "proposal_sent",
      amount: 1_250_000,
      currency: "INR",
      company: { id: "co1", name: "Tata Motors" },
    },
  ],
};
const EMPTY: SearchResults = { contacts: [], companies: [], deals: [] };

afterEach(() => {
  cleanup();
  mocks.search.mockReset();
});

async function renderPalette() {
  const onCreateContact = vi.fn();
  const onCreateCompany = vi.fn();
  const onCreateDeal = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <CommandPalette
          open
          onOpenChange={vi.fn()}
          onCreateContact={onCreateContact}
          onCreateCompany={onCreateCompany}
          onCreateDeal={onCreateDeal}
        />
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <div>at {path}</div> });
  const router = createRouter({
    routeTree: root.addChildren([
      page("/"),
      page("/contacts/$contactId"),
      page("/companies"),
      page("/companies/$companyId"),
      page("/deals"),
      page("/deals/$dealId"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  const input = await screen.findByRole("combobox");
  return { input, router, onCreateContact, onCreateCompany, onCreateDeal, queryClient };
}

const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

describe("CommandPalette search", () => {
  it("does not search below 2 characters", async () => {
    const { input } = await renderPalette();
    type(input, "a");
    expect(screen.getByText("Type at least 2 characters to search.")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 400));
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("debounces typing into one request for the settled query", async () => {
    mocks.search.mockResolvedValue(RESULTS);
    const { input, queryClient } = await renderPalette();
    type(input, "as");
    type(input, "ash");
    type(input, "asha");
    await waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1));
    expect(mocks.search).toHaveBeenCalledWith("asha", expect.anything());
    // Workspace-scoped cache key.
    await waitFor(() =>
      expect(queryClient.getQueryData(keys.search("ws-1", "asha"))).toEqual(RESULTS),
    );
  });

  it("groups contacts, companies and deals", async () => {
    mocks.search.mockResolvedValue(RESULTS);
    const { input } = await renderPalette();
    type(input, "tata");
    const contacts = await screen.findByRole("group", { name: "Contacts" });
    expect(within(contacts).getByText("Asha Rao")).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "Companies" })).getByText("tata.test"),
    ).toBeTruthy();
    const deals = screen.getByRole("group", { name: "Deals" });
    expect(within(deals).getByText("Tata fleet deal")).toBeTruthy();
    expect(within(deals).getByText("₹12.5 L")).toBeTruthy();
  });

  it("navigates with the keyboard: Enter opens the highlighted result", async () => {
    mocks.search.mockResolvedValue(RESULTS);
    const { input, router } = await renderPalette();
    type(input, "tata");
    await screen.findByText("Asha Rao");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Asha Rao/ })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const companies = screen.getByRole("group", { name: "Companies" });
    expect(within(companies).getByRole("option")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/contacts/c1"));
  });

  it("company and deal results open their pages", async () => {
    mocks.search.mockResolvedValue(RESULTS);
    const { input, router } = await renderPalette();
    type(input, "tata");
    fireEvent.click(await screen.findByText("tata.test"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/companies/co1"));
    type(input, "tata");
    fireEvent.click(await screen.findByText("Tata fleet deal"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/deals/d1"));
  });

  it("shows searching and no-results states", async () => {
    let resolve: (r: SearchResults) => void = () => undefined;
    mocks.search.mockImplementation(() => new Promise<SearchResults>((r) => (resolve = r)));
    const { input } = await renderPalette();
    type(input, "zzqq");
    expect(await screen.findByText("Searching…")).toBeTruthy();
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    resolve(EMPTY);
    expect(await screen.findByText(/No results for/)).toBeTruthy();
  });

  it("runs actions, filtered by the typed text", async () => {
    mocks.search.mockResolvedValue(EMPTY);
    const { input, onCreateContact, onCreateCompany, onCreateDeal, router } = await renderPalette();
    expect(screen.getByRole("option", { name: "Go to Tasks" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Create contact" }));
    expect(onCreateContact).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Create company" }));
    expect(onCreateCompany).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Create deal" }));
    expect(onCreateDeal).toHaveBeenCalled();

    type(input, "deals");
    expect(screen.queryByRole("option", { name: "Go to Tasks" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Go to Deals" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/deals"));
  });
});
