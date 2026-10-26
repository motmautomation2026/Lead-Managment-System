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
import type { CompanyDuplicate, DuplicateListParams } from "@/types";

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  listParams: [] as unknown[],
  rows: [] as unknown[],
  merge: vi.fn(),
  dismiss: vi.fn(),
  relink: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const co = (id: string, name: string) => ({
  id,
  name,
  domain: `${id}.example.com`,
  industry: "Automotive",
  merged: false,
  contactCount: 2,
  openDealCount: 1,
});
const pair: CompanyDuplicate = {
  id: "x-pair",
  kind: "pair",
  reason: "similar_name",
  score: 0.72,
  status: "open",
  createdAt: "2026-10-20T10:00:00.000Z",
  resolvedAt: null,
  companyA: co("co-a", "Bolt Motors"),
  companyB: co("co-b", "Bolt Motor"),
  contact: null,
  observedName: null,
  observedDomain: null,
};
const contactRow: CompanyDuplicate = {
  id: "x-contact",
  kind: "contact",
  reason: "same_domain_different_name",
  score: null,
  status: "open",
  createdAt: "2026-10-21T10:00:00.000Z",
  resolvedAt: null,
  companyA: co("co-t", "Tata Motors"),
  companyB: null,
  contact: { id: "c-1", name: "Ravi Kumar", email: "ravi@tatamotors.example.com", company: "TML" },
  observedName: "TML",
  observedDomain: "tatamotors.example.com",
};

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
  useCompanyDuplicates: (params: DuplicateListParams) => {
    mocks.listParams.push(params);
    return {
      data: { pages: [{ data: mocks.rows, nextCursor: null }] },
      isLoading: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    };
  },
  useCompanyDuplicatesCount: (params: DuplicateListParams) => ({
    data: { count: params.kind === "pair" ? 1 : params.kind === "contact" ? 1 : 2 },
  }),
  useMergeDuplicate: () => ({ mutateAsync: mocks.merge, isPending: false }),
  useDismissDuplicate: () => ({ mutateAsync: mocks.dismiss, isPending: false }),
  useRelinkDuplicate: () => ({ mutateAsync: mocks.relink, isPending: false }),
  useCompanySearch: (input: string) => ({
    data:
      input.trim().length >= 2
        ? { data: [{ id: "co-n", name: "Tata Motors Finance", domain: null }] }
        : undefined,
    isFetching: false,
  }),
  useCreateCompany: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { DuplicatesPage } from "./duplicates-page";
import { validateDuplicatesSearch } from "./duplicates-search";

async function renderPage(search: Record<string, unknown> = {}) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/companies/duplicates",
        validateSearch: validateDuplicatesSearch,
        component: DuplicatesPage,
      }),
      stub("/companies"),
      stub("/companies/$companyId"),
      stub("/contacts/$contactId"),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/companies/duplicates${defaultStringifySearch(search)}`],
    }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}
const rowOf = (text: string) =>
  screen.getByText(text, { selector: "a" }).closest("li") as HTMLElement;

beforeEach(() => {
  mocks.isAdmin = true;
  mocks.rows = [pair, contactRow];
  mocks.listParams = [];
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DuplicatesPage", () => {
  it("non-admins see an admins-only message", async () => {
    mocks.isAdmin = false;
    await renderPage();
    expect(await screen.findByText("Admins only")).toBeTruthy();
  });

  it("shows counts per kind; tabs and filters write the URL and the API params", async () => {
    const router = await renderPage();
    expect(await screen.findByRole("tab", { name: "All (2)" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Company pairs (1)" })).toBeTruthy();
    expect(screen.getByText("Similar name")).toBeTruthy();
    expect(screen.getByText(/similarity 72%/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Contact mismatches (1)" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ kind: "contact" }));
    expect(mocks.listParams.at(-1)).toMatchObject({ kind: "contact" });

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Merged" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ kind: "contact", status: ["merged"] }),
    );
    expect(mocks.listParams.at(-1)).toMatchObject({ status: ["merged"], kind: "contact" });
  });

  it("pair: merge keeping company B (confirmed), removed from the list at once", async () => {
    let resolve: () => void = () => undefined;
    mocks.merge.mockImplementation(() => new Promise<void>((r) => (resolve = r)));
    await renderPage();
    fireEvent.click(within(rowOf("Bolt Motors")).getByRole("button", { name: "Merge…" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge these companies?" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /^Bolt Motor(?!s)/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge into “Bolt Motor”" }));
    expect(mocks.merge).toHaveBeenCalledWith({ id: "x-pair", targetId: "co-b" });
    // Optimistic: gone before the request finishes.
    expect(screen.queryByText("Bolt Motors", { selector: "a" })).toBeNull();
    resolve();
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith("Merged into “Bolt Motor”"),
    );
  });

  it("pair: Not a duplicate dismisses; a failure brings the row back", async () => {
    mocks.dismiss.mockRejectedValue(new Error("This suggestion was already merged."));
    await renderPage();
    fireEvent.click(within(rowOf("Bolt Motors")).getByRole("button", { name: "Not a duplicate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Not a duplicate" }));
    expect(mocks.dismiss).toHaveBeenCalledWith("x-pair");
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith("This suggestion was already merged."),
    );
    expect(screen.getByText("Bolt Motors", { selector: "a" })).toBeTruthy();
  });

  it("contact row: keep link, create separate company, move to another company", async () => {
    mocks.dismiss.mockResolvedValue(undefined);
    mocks.relink.mockResolvedValue({ leadId: "c-1", companyId: "co-n" });
    await renderPage();
    const row = rowOf("Ravi Kumar");
    expect(within(row).getByText(/Says “TML”/)).toBeTruthy();
    expect(within(row).getByRole("link", { name: "Tata Motors" })).toHaveAttribute(
      "href",
      "/companies/co-t",
    );

    fireEvent.click(within(row).getByRole("button", { name: "Keep link" }));
    expect(mocks.dismiss).toHaveBeenCalledWith("x-contact");
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("Link kept"));
    cleanup();

    await renderPage();
    fireEvent.click(
      within(rowOf("Ravi Kumar")).getByRole("button", { name: "Create separate company" }),
    );
    expect(mocks.relink).toHaveBeenCalledWith({ id: "x-contact" });
    cleanup();

    await renderPage();
    fireEvent.click(
      within(rowOf("Ravi Kumar")).getByRole("button", { name: "Move to another company…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Move to another company" });
    expect(within(dialog).getByRole("button", { name: "Move" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Company" }));
    fireEvent.change(screen.getByLabelText("Search companies"), { target: { value: "tata" } });
    fireEvent.click(await screen.findByRole("option", { name: /Tata Motors Finance/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(mocks.relink).toHaveBeenLastCalledWith({ id: "x-contact", companyId: "co-n" });
  });

  it("resolved rows have no actions", async () => {
    mocks.rows = [{ ...pair, status: "merged", resolvedAt: "2026-10-22T10:00:00.000Z" }];
    await renderPage({ status: ["merged"] });
    expect(await screen.findByText("Bolt Motors", { selector: "a" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Merge…" })).toBeNull();
  });
});
