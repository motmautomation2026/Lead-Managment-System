import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  defaultStringifySearch,
} from "@tanstack/react-router";
import type { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavedView, SavedViewObject } from "@/types";

const mocks = vi.hoisted(() => ({
  isAdmin: false,
  views: [] as SavedView[],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
  useSavedViews: (object: string) => ({
    data: { data: mocks.views.filter((v) => v.object === object) },
  }),
  useCreateSavedView: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateSavedView: () => ({ mutateAsync: mocks.update, isPending: false }),
  useDeleteSavedView: () => ({ mutateAsync: mocks.remove, isPending: false }),
}));

import { useListUrlState } from "@/lib/use-list-url-state";
import { CONTACT_VIEW_SPEC, contactsSearchSchema } from "@/features/contacts/contacts-search";
import { COMPANY_VIEW_SPEC, companiesSearchSchema } from "@/features/companies/companies-search";
import { DEAL_VIEW_SPEC, dealsSearchSchema } from "@/features/deals/deals-search";
import { SavedViewTabs } from "./saved-view-tabs";
import { useListViews } from "./use-list-views";
import { matchesView, type ListViewSpec, type ListViewState } from "./saved-views";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.create.mockReset();
  mocks.update.mockReset();
  mocks.remove.mockReset();
  mocks.isAdmin = false;
  mocks.views = [];
});

function view(object: SavedViewObject, extra: Partial<SavedView>): SavedView {
  return {
    id: "v-1",
    object,
    name: "Hot",
    filters: {},
    sort: null,
    columns: null,
    isShared: false,
    position: 0,
    ownerId: "u-1",
    isMine: true,
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}

const CASES = [
  {
    object: "contacts" as const,
    spec: CONTACT_VIEW_SPEC as unknown as ListViewSpec<ListViewState>,
    schema: contactsSearchSchema as z.ZodTypeAny,
    stored: { leadStatus: "new" },
    url: { leadStatus: ["new"] },
    extra: { source: ["referral"] },
  },
  {
    object: "companies" as const,
    spec: COMPANY_VIEW_SPEC as unknown as ListViewSpec<ListViewState>,
    schema: companiesSearchSchema as z.ZodTypeAny,
    stored: { industry: "Steel" },
    url: { industry: ["Steel"] },
    extra: { hasDomain: "true" },
  },
  {
    object: "deals" as const,
    spec: DEAL_VIEW_SPEC as unknown as ListViewSpec<ListViewState>,
    schema: dealsSearchSchema as z.ZodTypeAny,
    stored: { stage: "negotiation" },
    url: { stage: ["negotiation"] },
    extra: { amountMin: "1000" },
  },
];

describe.each(CASES)("saved views: $object", ({ object, spec, schema, stored, url, extra }) => {
  function Harness() {
    const [state, set] = useListUrlState(schema);
    const controller = useListViews(spec, state as ListViewState, set);
    return <SavedViewTabs controller={controller} />;
  }

  async function renderTabs(search: Record<string, unknown> = {}) {
    const root = createRootRoute({ component: () => <Outlet /> });
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({ getParentRoute: () => root, path: "/", component: Harness }),
      ]),
      history: createMemoryHistory({ initialEntries: [`/${defaultStringifySearch(search)}`] }),
    });
    await router.load();
    render(<RouterProvider router={router} />);
    await screen.findByRole("tablist", { name: "Views" });
    return router;
  }
  const searchOf = (router: Awaited<ReturnType<typeof renderTabs>>) =>
    router.state.location.search as Record<string, unknown>;
  const change = (router: Awaited<ReturnType<typeof renderTabs>>, patch: object) =>
    act(() => router.navigate({ to: "/", search: (prev: object) => ({ ...prev, ...patch }) }));
  const openManage = async () => {
    fireEvent.pointerDown(screen.getByRole("button", { name: "View options" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage views…" }));
    return screen.findByRole("dialog", { name: "Manage views" });
  };

  it("Edited marker when the URL drifts from the saved view; Save (PATCH), Reset re-applies", async () => {
    mocks.views = [view(object, { filters: stored, sort: "createdAt:asc" })];
    mocks.update.mockResolvedValue({});
    const router = await renderTabs({ view: "v-1", ...url, sort: "createdAt:asc" });
    expect(screen.getByRole("tab", { name: "Hot" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Edited")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();

    await change(router, extra);
    expect(await screen.findByRole("tab", { name: /^Hot\s*Edited$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        id: "v-1",
        input: { filters: { ...url, ...extra }, sort: "createdAt:asc", columns: null },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(searchOf(router)).toEqual({ view: "v-1", ...url, sort: "createdAt:asc" }),
    );
    expect(screen.queryByText("Edited")).toBeNull();
  });

  it("built-in views offer only Save as new; the dialog needs a name, shares, goes last", async () => {
    mocks.views = [view(object, { position: 4 })];
    mocks.create.mockResolvedValue({ id: "v-new" });
    const router = await renderTabs(extra);
    expect(screen.getAllByRole("tab")[0]!.textContent).toContain("Edited");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save as new" }));
    const dialog = await screen.findByRole("dialog", { name: "Save view" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Name the view.")).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("View name"), { target: { value: " Team " } });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        object,
        name: "Team",
        isShared: true,
        filters: extra,
        sort: null,
        columns: null,
        position: 5,
      }),
    );
    await waitFor(() => expect(searchOf(router)["view"]).toBe("v-new"));
  });

  it("shows the API's 409 (30-view limit) inside the save dialog", async () => {
    mocks.create.mockRejectedValue(
      new Error("You can save up to 30 views per list. Delete one first."),
    );
    await renderTabs(extra);
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    const dialog = await screen.findByRole("dialog", { name: "Save view" });
    fireEvent.change(within(dialog).getByLabelText("View name"), { target: { value: "One more" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("up to 30 views");
  });

  it("someone else's shared view: Save as new and Reset, no Save; no controls in Manage", async () => {
    mocks.views = [view(object, { name: "Team", isShared: true, isMine: false, ownerId: "u-2" })];
    const router = await renderTabs({ view: "v-1" });
    await change(router, extra);
    expect(await screen.findByRole("button", { name: "Reset" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as new" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    const dialog = await openManage();
    expect(within(dialog).getByText("Shared by a teammate")).toBeTruthy();
    for (const action of ["Rename", "Delete", "Reorder", "Share"])
      expect(
        within(dialog).queryByRole(action === "Share" ? "switch" : "button", {
          name: `${action} Team`,
        }),
      ).toBeNull();
  });

  it("admins may rename/delete shared views of others, but not share them", async () => {
    mocks.isAdmin = true;
    mocks.views = [view(object, { name: "Team", isShared: true, isMine: false, ownerId: "u-2" })];
    await renderTabs();
    const dialog = await openManage();
    expect(within(dialog).getByRole("button", { name: "Rename Team" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Delete Team" })).toBeTruthy();
    expect(within(dialog).queryByRole("switch", { name: "Share Team" })).toBeNull();
  });

  it("Manage views: rename inline, share, delete with confirm (active view → All)", async () => {
    mocks.views = [view(object, { filters: stored })];
    mocks.update.mockResolvedValue({});
    mocks.remove.mockResolvedValue(undefined);
    const router = await renderTabs({ view: "v-1", ...url });
    const dialog = await openManage();

    fireEvent.click(within(dialog).getByRole("button", { name: "Rename Hot" }));
    fireEvent.change(within(dialog).getByLabelText("View name"), { target: { value: "Hotter" } });
    fireEvent.submit(within(dialog).getByLabelText("View name"));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ id: "v-1", input: { name: "Hotter" } }),
    );

    fireEvent.click(within(dialog).getByRole("switch", { name: "Share Hot" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ id: "v-1", input: { isShared: true } }),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Hot" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete view" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("v-1"));
    await waitFor(() => expect(searchOf(router)).toEqual({}));
  });

  it("Manage views: a failed write shows the API's error inline", async () => {
    mocks.views = [view(object, {})];
    mocks.update.mockRejectedValue(
      new Error("Only the owner or an admin can change a shared view."),
    );
    await renderTabs();
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole("switch", { name: "Share Hot" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Only the owner");
  });

  it("Manage views: reorder by keyboard → PATCH position for the views that moved", async () => {
    mocks.views = [
      view(object, { id: "v-a", name: "A", position: 0 }),
      view(object, { id: "v-b", name: "B", position: 1 }),
      view(object, { id: "v-c", name: "C", position: 2 }),
    ];
    mocks.update.mockResolvedValue({});
    // jsdom has no layout: stack the rows 40 px apart so the keyboard sensor can find them.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const li = this.closest("li");
      const i = li ? Array.from(li.parentElement!.children).indexOf(li) : 0;
      const rect = { left: 0, top: i * 40, width: 300, height: 40 };
      return {
        ...rect,
        right: 300,
        bottom: rect.top + 40,
        x: 0,
        y: rect.top,
        toJSON: () => rect,
      } as DOMRect;
    });
    await renderTabs();
    const dialog = await openManage();
    const handle = within(dialog).getByRole("button", { name: "Reorder A" });
    handle.focus();
    fireEvent.keyDown(handle, { code: "Space", key: " " });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => {
      fireEvent.keyDown(document, { code: "ArrowDown", key: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(document, { code: "Space", key: " " });
    });
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update).toHaveBeenCalledWith({ id: "v-b", input: { position: 0 } });
    expect(mocks.update).toHaveBeenCalledWith({ id: "v-a", input: { position: 1 } });
  });
});

describe("matchesView", () => {
  const spec = CONTACT_VIEW_SPEC as unknown as ListViewSpec<ListViewState>;
  it("ignores multi-value order and treats absent sort/columns as the defaults", () => {
    expect(
      matchesView(
        spec,
        { ownerId: ["b", "a"], sort: "createdAt:desc" } as ListViewState,
        {
          ownerId: ["a", "b"],
        } as ListViewState,
      ),
    ).toBe(true);
    expect(
      matchesView(spec, { columns: spec.defaultColumns } as ListViewState, {} as ListViewState),
    ).toBe(true);
    expect(matchesView(spec, { q: "acme" } as ListViewState, {} as ListViewState)).toBe(false);
    expect(matchesView(spec, { sort: "name:asc" } as ListViewState, {} as ListViewState)).toBe(
      false,
    );
  });
});
