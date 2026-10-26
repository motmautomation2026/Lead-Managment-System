import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lead } from "@/types/lead";

const noop = vi.fn(async () => undefined);
const mockRole = vi.hoisted(() => ({ isAdmin: false }));
const mockOverdue = vi.hoisted(() => ({ count: null as number | null }));

const leads: Lead[] = [
  {
    id: "lead-1",
    firstName: "John",
    lastName: "Smith",
    company: "Acme Corp",
    jobTitle: "VP Sales",
    industry: "Manufacturing",
    phone: "+1-555-0100",
    email: "john.smith@acme.test",
    source: "linkedin",
    serviceInterest: "Automation Suite",
    pipelineStage: "connected_qualifying",
    lifecycleState: "active",
    automationMode: "active",
    agentStatus: "none",
    agentTouchCount: 0,
    responseState: "no_response",
    doNotContact: false,
    lastActivityAt: "2026-09-01T00:00:00.000Z",
    nextAction: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    id: "lead-2",
    firstName: "Priya",
    lastName: "Nair",
    company: "Globex",
    jobTitle: "CTO",
    industry: "Software",
    phone: "+1-555-0101",
    email: "priya.nair@globex.test",
    source: "referral",
    serviceInterest: "Consulting",
    pipelineStage: "negotiation",
    lifecycleState: "active",
    automationMode: "manual",
    agentStatus: "none",
    agentTouchCount: 0,
    responseState: "responded",
    doNotContact: false,
    lastActivityAt: "2026-09-02T00:00:00.000Z",
    nextAction: null,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  },
];

vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Request failed"),
  useSession: () => ({
    users: [],
    currentUser: { name: "Test User", role: "Salesperson", initials: "TU" },
    userName: () => "Unassigned",
    isLoading: false,
    error: null,
  }),
  useIsAdmin: () => mockRole.isAdmin,
  useCompanyDuplicatesCount: (_params: unknown, enabled: boolean) => ({
    data: enabled ? { count: 4 } : undefined,
  }),
  useLeads: () => ({
    leads,
    getLead: (id: string) => leads.find((l) => l.id === id),
    isLoading: false,
    error: null,
    isPending: false,
    addLead: noop,
    updateLead: noop,
    addNote: noop,
    setAutomation: noop,
    markDnc: noop,
    reactivateFromDnc: noop,
    logCall: noop,
    logCommunication: noop,
    setLifecycle: noop,
  }),
  useNotifications: () => ({
    notifications: [],
    markNotificationsRead: noop,
  }),
  useGlobalSearch: () => ({ enabled: false, query: "", isSearching: false, isError: false }),
  useCreateContact: () => ({ mutateAsync: noop, isPending: false }),
  useCompanySearch: () => ({ data: undefined }),
  useCreateCompany: () => ({ mutateAsync: noop, isPending: false }),
  useCreateDeal: () => ({ mutateAsync: noop, isPending: false }),
  useUpdateDeal: () => ({ mutateAsync: noop, isPending: false }),
  useContact: () => ({ data: undefined }),
  useContactSearch: () => ({ data: undefined, isFetching: false, isError: false }),
  useCreateTask: () => ({ mutateAsync: noop, isPending: false }),
  useCreateMeeting: () => ({ mutateAsync: noop, isPending: false }),
  useUpdateMeeting: () => ({ mutateAsync: noop, isPending: false }),
  useTaskCount: () => ({ data: mockOverdue.count === null ? undefined : mockOverdue }),
}));

vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({
    workspaces: [],
    currentWorkspaceId: null,
    currentWorkspace: null,
    setCurrentWorkspaceId: noop,
    isLoading: false,
  }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "@/app/app-shell";
import { ThemeProvider } from "@/app/theme-provider";
import { SIDEBAR_KEY } from "@/lib/preferences";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = "";
});
afterEach(cleanup);

async function renderShell(path = "/") {
  const queryClient = new QueryClient();
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AppShell>
            <Outlet />
          </AppShell>
        </ThemeProvider>
      </QueryClientProvider>
    ),
  });
  const page = (path: string, text: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => <div>{text}</div> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      page("/", "home"),
      page("/contacts", "contacts page"),
      page("/contacts/$contactId", "lead detail"),
      page("/tasks", "tasks page"),
      page("/meetings", "meetings page"),
      page("/proposals", "proposals page"),
      page("/companies", "companies page"),
      page("/deals", "deals page"),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/list",
        component: () => <input aria-label="List search" data-list-search />,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const view = render(<RouterProvider router={router} />);
  return { view, router };
}

/** Radix menus open on keyboard in jsdom (no pointer events). */
function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
}

describe("AppShell nav", () => {
  it("shows the Admin item only to admins", async () => {
    mockRole.isAdmin = false;
    await renderShell();
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
    cleanup();

    mockRole.isAdmin = true;
    await renderShell();
    expect(screen.getByRole("link", { name: "Admin" }).getAttribute("href")).toBe("/admin");
    mockRole.isAdmin = false;
  });

  it("admins see the open duplicate count on Companies; others don't", async () => {
    await renderShell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Companies" })).toBeTruthy();
    cleanup();

    mockRole.isAdmin = true;
    await renderShell();
    const adminNav = screen.getByRole("navigation", { name: "Main" });
    const companies = within(adminNav).getByRole("link", {
      name: /^Companies.*4 possible duplicate companies to review$/,
    });
    expect(companies).toHaveTextContent("4");
    mockRole.isAdmin = false;
  });

  it("Tasks shows my overdue count as a badge, none when nothing is overdue", async () => {
    mockOverdue.count = 4;
    await renderShell();
    expect(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", {
        name: /^Tasks.*4 overdue tasks$/,
      }),
    ).toHaveTextContent("4");
    cleanup();
    mockOverdue.count = 0;
    await renderShell();
    expect(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Tasks" }),
    ).toBeTruthy();
    mockOverdue.count = null;
  });

  it("groups CRM, Work and Automation with the existing URLs", async () => {
    await renderShell("/contacts/lead-1");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const href = (name: string) => within(nav).getByRole("link", { name }).getAttribute("href");
    expect(within(nav).getByText("CRM")).toBeTruthy();
    expect(href("Contacts")).toBe("/contacts");
    expect(href("Companies")).toBe("/companies");
    expect(href("Deals")).toBe("/deals");
    expect(href("Dashboard")).toBe("/");
    expect(href("Workflows")).toBe("/automations");
    expect(within(nav).getByRole("link", { name: "Contacts" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows route breadcrumbs", async () => {
    await renderShell("/contacts/lead-1");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Contacts" })).toHaveAttribute(
      "href",
      "/contacts",
    );
    expect(within(crumbs).getByText("Contact")).toBeTruthy();
  });

  it("collapses to icons and remembers it", async () => {
    await renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("true");
    expect(screen.getByText("Contacts")).toHaveClass("sr-only");
    cleanup();

    await renderShell();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  });

  it("opens the mobile drawer and closes it on navigation", async () => {
    await renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(drawer).getByRole("link", { name: "Tasks" }));
    expect(await screen.findByText("tasks page")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  });
});

describe("AppShell top bar", () => {
  it("+ Create → Contact / Company / Deal / Task / Meeting open their dialogs", async () => {
    await renderShell();
    openMenu("Create");
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("Coming soon")).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Task" }));
    const task = await screen.findByRole("dialog", { name: "Create task" });
    expect(within(task).getByRole("button", { name: "Contact" })).toBeTruthy();
    fireEvent.keyDown(task, { key: "Escape" });
    openMenu("Create");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Meeting" }));
    const meeting = await screen.findByRole("dialog", { name: "Schedule meeting" });
    expect(within(meeting).getByRole("button", { name: "Contact" })).toBeTruthy();
    fireEvent.keyDown(meeting, { key: "Escape" });
    openMenu("Create");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Contact" }));
    expect(await screen.findByRole("dialog", { name: "Create contact" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    openMenu("Create");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Company" }));
    expect(await screen.findByRole("dialog", { name: "Create company" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    openMenu("Create");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Deal" }));
    const deal = await screen.findByRole("dialog", { name: "Create deal" });
    expect(within(deal).getByRole("button", { name: "Contact" })).toBeTruthy();
    // Five lazy dialogs in a row: slow under a full parallel run.
  }, 20_000);

  it("user menu switches the theme", async () => {
    await renderShell();
    openMenu("Account menu");
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
    expect(document.documentElement).toHaveClass("dark");
  });

  it("keeps the ⌘K shortcut and opens search from the top bar", async () => {
    await renderShell();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("the palette is lazy: not mounted before ⌘K, opens on the first press", async () => {
    await renderShell();
    expect(screen.queryByPlaceholderText(/Search contacts, companies, deals/)).toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });
    expect(await screen.findByPlaceholderText(/Search contacts, companies, deals/)).toBeTruthy();
  });
});

describe("AppShell keyboard shortcuts (C5)", () => {
  const press = (key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
      );
    });

  it("g then c / o / d / t / m / p go to Contacts / Companies / Deals / Tasks / Meetings / Proposals", async () => {
    const { router } = await renderShell();
    for (const [key, path] of [
      ["c", "/contacts"],
      ["o", "/companies"],
      ["d", "/deals"],
      ["t", "/tasks"],
      ["m", "/meetings"],
      ["p", "/proposals"],
    ] as const) {
      press("g");
      press(key);
      await screen.findByText(`${path.slice(1)} page`);
      expect(router.state.location.pathname).toBe(path);
    }
  });

  it("n opens the + Create menu; ? opens the help dialog listing every shortcut", async () => {
    await renderShell();
    press("n");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Deal" })).toBeTruthy();
    fireEvent.keyDown(menu, { key: "Escape" });
    await act(async () => undefined);
    press("?", document.body, { shiftKey: true });
    const help = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    for (const label of [
      "Search and commands",
      "Search the current list",
      "Open the Create menu",
      "Go to Tasks",
      "Go to Meetings",
      "Go to Proposals",
    ])
      expect(within(help).getByText(label)).toBeTruthy();
    // With a dialog open, other shortcuts do nothing.
    press("g");
    press("c");
    expect(screen.queryByText("contacts page")).toBeNull();
  });

  it("/ focuses the list's search box; keys typed in a field never trigger shortcuts", async () => {
    const { router } = await renderShell("/list");
    const input = await screen.findByLabelText("List search");
    press("/");
    expect(document.activeElement).toBe(input);
    press("g", input);
    press("c", input);
    press("n", input);
    expect(router.state.location.pathname).toBe("/list");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ignores Ctrl/Alt/Meta (except ⌘K / Ctrl+K)", async () => {
    const { router } = await renderShell();
    press("g", document.body, { ctrlKey: true });
    press("c");
    press("n", document.body, { altKey: true });
    expect(router.state.location.pathname).toBe("/");
    expect(screen.queryByRole("menu")).toBeNull();
    press("k", document.body, { metaKey: true });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("user menu → Keyboard shortcuts opens the help dialog", async () => {
    await renderShell();
    openMenu("Account menu");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Keyboard shortcuts/ }));
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });
});
