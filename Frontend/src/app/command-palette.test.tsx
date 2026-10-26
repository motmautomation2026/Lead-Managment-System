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
  vi.restoreAllMocks();
  window.localStorage.clear();
});

async function renderPalette() {
  const onCreateContact = vi.fn();
  const onCreateCompany = vi.fn();
  const onCreateDeal = vi.fn();
  const onCreateTask = vi.fn();
  const onScheduleMeeting = vi.fn();
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
          onCreateTask={onCreateTask}
          onScheduleMeeting={onScheduleMeeting}
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
      page("/search"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  const input = await screen.findByRole("combobox");
  return {
    input,
    router,
    onCreateContact,
    onCreateCompany,
    onCreateDeal,
    onCreateTask,
    onScheduleMeeting,
    queryClient,
  };
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
    const {
      input,
      onCreateContact,
      onCreateCompany,
      onCreateDeal,
      onCreateTask,
      onScheduleMeeting,
      router,
    } = await renderPalette();
    expect(screen.getByRole("option", { name: "Go to Tasks" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Create contact" }));
    expect(onCreateContact).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Create company" }));
    expect(onCreateCompany).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Create deal" }));
    expect(onCreateDeal).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Create task" }));
    expect(onCreateTask).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Schedule meeting" }));
    expect(onScheduleMeeting).toHaveBeenCalled();

    type(input, "deals");
    expect(screen.queryByRole("option", { name: "Go to Tasks" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Go to Deals" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/deals"));
  });
});

describe("CommandPalette recents and See all (C5)", () => {
  it("empty query: recent records (newest first) then quick actions; a recent opens its page", async () => {
    window.localStorage.setItem(
      "motmflow.recent.ws-1",
      JSON.stringify([
        { type: "deal", id: "d1", label: "Tata fleet deal" },
        { type: "company", id: "co1", label: "Tata Motors" },
        { type: "contact", id: "c1", label: "Asha Rao" },
      ]),
    );
    const { router } = await renderPalette();
    const recent = screen.getByRole("group", { name: "Recent" });
    expect(
      within(recent)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Tata fleet dealDeal", "Tata MotorsCompany", "Asha RaoContact"]);
    const actions = within(screen.getByRole("group", { name: "Actions" }))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(actions).toEqual([
      "Create contact",
      "Create company",
      "Create deal",
      "Create task",
      "Schedule meeting",
      "Go to Contacts",
      "Go to Companies",
      "Go to Deals",
      "Go to Tasks",
      "Go to Meetings",
      "Go to Proposals",
    ]);
    fireEvent.click(within(recent).getByText("Tata Motors"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/companies/co1"));
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("no recents (or broken storage) → just the quick actions", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await renderPalette();
    expect(screen.queryByRole("group", { name: "Recent" })).toBeNull();
    expect(screen.getByRole("option", { name: "Create deal" })).toBeTruthy();
  });

  it("typing hides recents; See all results is the last row and opens /search?q=", async () => {
    window.localStorage.setItem(
      "motmflow.recent.ws-1",
      JSON.stringify([{ type: "contact", id: "c9", label: "Old Recent" }]),
    );
    mocks.search.mockResolvedValue(RESULTS);
    const { input, router } = await renderPalette();
    type(input, "tata");
    await screen.findByText("Asha Rao");
    expect(screen.queryByText("Old Recent")).toBeNull();
    const options = screen.getAllByRole("option");
    expect(options.at(-1)?.textContent).toBe("See all results for “tata”");
    fireEvent.click(options.at(-1)!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/search"));
    expect(router.state.location.search).toEqual({ q: "tata" });
  });

  it("no See all below 2 characters", async () => {
    const { input } = await renderPalette();
    type(input, "t");
    expect(screen.queryByText(/See all results/)).toBeNull();
  });
});
