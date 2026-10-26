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
  it("+ Create → Contact / Company / Deal open their dialogs; others are coming soon", async () => {
    await renderShell();
    openMenu("Create");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Task/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Contact" }));
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
  });

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
});
