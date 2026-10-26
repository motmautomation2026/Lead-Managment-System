import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompanyDetail,
  CompanyDuplicate,
  CompanyTimelineEvent,
  ContactListItem,
  DealListItem,
} from "@/types";

const mocks = vi.hoisted(() => ({
  isAdmin: false,
  companies: {} as Record<string, unknown>,
  update: vi.fn(),
  merge: vi.fn(),
  openAdd: vi.fn(),
  openDeal: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const company = (id: string, name: string, extra: Partial<CompanyDetail> = {}): CompanyDetail => ({
  id,
  name,
  domain: `${id}.example.com`,
  industry: "Automotive",
  city: "Pune",
  owner: { id: "u-1", name: "Rep One" },
  contactCount: 3,
  openDealCount: 1,
  openDealAmount: 1_500_000,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  website: null,
  revenueRange: null,
  revenueMinCr: null,
  revenueMaxCr: null,
  state: null,
  country: "India",
  linkedinUrl: null,
  employeeRange: null,
  description: null,
  mergedIntoCompanyId: null,
  createdBy: "Rep One",
  lastActivityAt: "2026-10-20T10:00:00.000Z",
  ...extra,
});
const contactRow = {
  id: "c-1",
  name: "Asha Rao",
  firstName: "Asha",
  lastName: "Rao",
  email: "asha@tata.test",
  phone: null,
  jobTitle: "CTO",
  source: "website",
  company: { id: "co-1", name: "Tata Motors" },
  owner: null,
  leadStatus: "new",
  lifecycle: "active",
  openDeal: null,
  agentStatus: "none",
  nextAction: null,
  lastActivityAt: "2026-10-20T10:00:00.000Z",
  createdAt: "2026-10-01T10:00:00.000Z",
} as ContactListItem;
const dealRow = {
  id: "d-1",
  name: "Tata – Fleet",
  stage: "proposal_sent",
  amount: 1_500_000,
  currency: "INR",
  expectedCloseDate: "2026-12-01",
  owner: { id: "u-1", name: "Rep One" },
  company: { id: "co-1", name: "Tata Motors" },
  contact: { id: "c-1", name: "Asha Rao" },
  source: "manual",
  closedAt: null,
  createdAt: "",
  updatedAt: "",
} as DealListItem;
const feedRow = {
  id: "e-1",
  leadId: "c-1",
  at: "2026-10-20T10:00:00.000Z",
  kind: "call",
  title: "Call logged",
  actor: "Rep One",
  source: "manual",
  contact: { id: "c-1", name: "Asha Rao" },
} as CompanyTimelineEvent;
const duplicate = {
  id: "x-1",
  kind: "pair",
  reason: "similar_name",
  score: 0.7,
  status: "open",
  createdAt: "",
  resolvedAt: null,
  companyA: { id: "co-1", name: "Tata Motors" },
  companyB: { id: "co-2", name: "Tata Motor" },
  contact: null,
  observedName: null,
  observedDomain: null,
} as CompanyDuplicate;
const page = <T,>(rows: T[]) => ({
  data: { pages: [{ data: rows, nextCursor: null }] },
  isLoading: false,
  error: null,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
});

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/app/add-lead-context", () => ({
  useAddLead: () => ({ open: mocks.openAdd }),
  useCreateDealDialog: () => ({ open: mocks.openDeal }),
}));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
  useSession: () => ({ users: [{ id: "u-1", name: "Rep One", active: true }] }),
  useCompany: (id?: string) => ({
    data: id ? mocks.companies[id] : undefined,
    isLoading: false,
    error: null,
  }),
  useCompanyContacts: () => page([contactRow]),
  useCompanyDeals: () => page([dealRow]),
  useCompanyDuplicates: (_p: unknown, enabled: boolean) => page(enabled ? [duplicate] : []),
  useCompanyTimeline: () => page([feedRow]),
  useContactTimeline: () => page([]),
  useDealTimeline: () => page([]),
  useContactSearch: () => ({ data: undefined, isFetching: false, isError: false }),
  useContact: () => ({ data: undefined, isLoading: false, error: null }),
  useUpdateCompany: () => ({ mutateAsync: mocks.update, isPending: false }),
  useMergeCompanies: () => ({ mutateAsync: mocks.merge, isPending: false }),
  useCompanySearch: (input: string) => ({
    data:
      input.trim().length >= 2
        ? { data: [{ id: "co-2", name: "Tata Motor", domain: null }] }
        : undefined,
    isFetching: false,
  }),
  useCreateCompany: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateDeal: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { CompanyRecordPage } from "./company-record-page";

async function renderPage(id = "co-1") {
  const root = createRootRoute({ component: () => <Outlet /> });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <div>at {path}</div> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => <CompanyRecordPage companyId={id} />,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/companies/$companyId",
        component: () => <div>company page</div>,
      }),
      stub("/companies"),
      stub("/companies/duplicates"),
      stub("/contacts"),
      stub("/contacts/$contactId"),
      stub("/deals/$dealId"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}
const openTab = (name: string) => {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
};

beforeEach(() => {
  mocks.isAdmin = false;
  mocks.companies = {
    "co-1": company("co-1", "Tata Motors"),
    "co-2": company("co-2", "Tata Motor", { contactCount: 1, openDealCount: 0, openDealAmount: 0 }),
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CompanyRecordPage", () => {
  it("renders the header and every tab (one column below lg)", async () => {
    await renderPage();
    expect(await screen.findByRole("heading", { name: "Tata Motors" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /co-1\.example\.com/ })).toHaveAttribute(
      "href",
      "https://co-1.example.com",
    );
    expect(screen.getByText("Automotive · Pune")).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "About",
      "Overview",
      "Activity",
      "Contacts",
      "Deals",
      "Related",
    ]);
    // Overview (default): key facts, recent activity with the contact's name, open deals.
    expect(screen.getByText("Last activity")).toBeTruthy();
    expect(screen.getByText("Call logged")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Tata – Fleet" })).toHaveAttribute(
      "href",
      "/deals/d-1",
    );

    openTab("Activity");
    expect(screen.getByRole("group", { name: "Activity type" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Asha Rao" })).toHaveAttribute("href", "/contacts/c-1");
    openTab("Contacts");
    expect(
      within(screen.getByRole("table", { name: "Company contacts" })).getByText("asha@tata.test"),
    ).toBeTruthy();
    openTab("Deals");
    expect(
      within(screen.getByRole("table", { name: "Company deals" })).getByText("Tata – Fleet"),
    ).toBeTruthy();
    openTab("About");
    expect(screen.getByText("India")).toBeTruthy();
    openTab("Related");
    expect(screen.getByRole("heading", { name: /Contacts/ })).toBeTruthy();
    // Not an admin: no merge, no duplicate card.
    expect(screen.queryByRole("button", { name: /More/ })).toBeNull();
    expect(screen.queryByText("Possible duplicates")).toBeNull();
  });

  it("Add contact opens Create contact prefilled with the company name", async () => {
    await renderPage();
    fireEvent.click((await screen.findAllByRole("button", { name: /Add contact/ }))[0]!);
    expect(mocks.openAdd).toHaveBeenCalledWith({ company: "Tata Motors" });
  });

  it("Create deal opens the app-wide dialog limited to this company; deals link to the deal", async () => {
    await renderPage();
    fireEvent.click((await screen.findAllByRole("button", { name: /Create deal/ }))[0]!);
    expect(mocks.openDeal).toHaveBeenCalledWith({ companyId: "co-1", stay: true });
    expect(screen.getAllByRole("link", { name: "Tata – Fleet" })[0]).toHaveAttribute(
      "href",
      "/deals/d-1",
    );
  });

  it("inline edit saves with PATCH and shows a 409 inline", async () => {
    mocks.update.mockResolvedValueOnce({});
    await renderPage();
    openTab("About");
    fireEvent.click(screen.getByRole("button", { name: "Edit Industry" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Industry" }), {
      target: { value: " Steel " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ id: "co-1", input: { industry: "Steel" } }),
    );

    mocks.update.mockRejectedValueOnce(new Error('"Bolt" already uses this domain.'));
    fireEvent.click(screen.getByRole("button", { name: "Edit Domain" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Domain" }), {
      target: { value: "bolt.in" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText('"Bolt" already uses this domain.')).toBeTruthy();

    // Client rules first: an invalid domain never reaches the API.
    mocks.update.mockClear();
    fireEvent.change(screen.getByRole("textbox", { name: "Domain" }), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Use a domain like example.com.")).toBeTruthy();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("a rename asks first: it also renames the company on its contacts", async () => {
    mocks.update.mockResolvedValue({});
    await renderPage();
    openTab("About");
    fireEvent.click(screen.getByRole("button", { name: "Edit Name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Tata Motors Ltd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("This also updates the company name on 3 contacts."),
    ).toBeTruthy();
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ id: "co-1", input: { name: "Tata Motors Ltd" } }),
    );
  });

  it("admins: duplicates card and Merge into another company (keep the other one)", async () => {
    mocks.isAdmin = true;
    mocks.merge.mockResolvedValue({ targetId: "co-2", sourceId: "co-1", movedContacts: 3 });
    const router = await renderPage();
    openTab("Related");
    expect(screen.getByText("Possible duplicates")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute(
      "href",
      "/companies/duplicates",
    );

    fireEvent.keyDown(screen.getByRole("button", { name: /More/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Merge into another company…" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge companies" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Other company" }));
    fireEvent.change(screen.getByLabelText("Search companies"), { target: { value: "tata" } });
    fireEvent.click(await screen.findByRole("option", { name: /Tata Motor$/ }));

    const sides = within(dialog).getByRole("radiogroup", { name: "Company that stays" });
    expect(within(sides).getByRole("radio", { name: /Tata Motors.*Stays/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(dialog.textContent).toContain("move from “Tata Motor” to “Tata Motors”");
    fireEvent.click(within(sides).getByRole("radio", { name: /^Tata Motor(?!s).*Merged away/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge into “Tata Motor”" }));
    await waitFor(() =>
      expect(mocks.merge).toHaveBeenCalledWith({ targetId: "co-2", sourceId: "co-1" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/companies/co-2"));
  });

  it("a merged company points to the company it went into", async () => {
    mocks.companies["co-1"] = company("co-1", "Tata Motors", { mergedIntoCompanyId: "co-2" });
    await renderPage();
    expect(await screen.findByText("“Tata Motors” was merged into “Tata Motor”")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Tata Motor" })).toHaveAttribute(
      "href",
      "/companies/co-2",
    );
  });
});
