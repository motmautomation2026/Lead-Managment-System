import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  usersCreate: vi.fn(),
  usersUpdate: vi.fn(),
  setTheme: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  pending: () => new Promise<never>(() => undefined),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("qrcode.react", () => ({ QRCodeSVG: () => null }));
vi.mock("@/lib/supabase-client", () => ({ backendBaseUrl: "http://api.test" }));
vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({
    currentWorkspace: { id: "ws-1", name: "MOTM" },
    currentWorkspaceId: "ws-1",
    isLoading: false,
  }),
}));
vi.mock("@/app/theme-context", () => ({
  useTheme: () => ({
    theme: "system",
    setTheme: mocks.setTheme,
    density: "comfortable",
    setDensity: vi.fn(),
  }),
}));
// Their own tests cover these panels.
vi.mock("./agent-panel", () => ({ AgentPanel: () => <div>agent panel</div> }));
vi.mock("./email-settings", () => ({ EmailPanel: () => <div>email panel</div> }));
vi.mock("./lead-assignment-panel", () => ({
  LeadAssignmentPanel: () => <div>assignment panel</div>,
}));
vi.mock("@/lib/backend-client", () => ({
  backend: {
    connections: {
      whatsapp: { get: mocks.pending },
      googleCalendar: { get: mocks.pending },
    },
    admin: {
      users: {
        list: async () => ({
          data: [{ id: "u-1", name: "Rep One", email: "rep@motm.test", active: true }],
        }),
        create: mocks.usersCreate,
        update: mocks.usersUpdate,
      },
    },
  },
}));
vi.mock("@/store", async () => {
  const { keys } = await import("@/store/query");
  return {
    keys,
    messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
    useIsAdmin: () => mocks.isAdmin,
    useSession: () => ({ users: [], userName: () => "-" }),
  };
});

import { SettingsPage } from "./settings-page";
import { validateSettingsSearch } from "./settings-search";

async function renderPage(search: Record<string, unknown> = {}) {
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={new QueryClient()}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/settings",
        validateSearch: validateSettingsSearch,
        component: SettingsPage,
      }),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/settings${defaultStringifySearch(search)}`],
    }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "Settings" });
  return router;
}
const sections = () =>
  within(screen.getByRole("navigation", { name: "Settings sections" }))
    .getAllByRole("button")
    .map((b) => b.textContent);

beforeEach(() => {
  mocks.isAdmin = true;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SettingsPage (C6b)", () => {
  it("admins get every section; the tab lives in the URL", async () => {
    const router = await renderPage();
    expect(sections()).toEqual(["Workspace", "Lead assignment", "AI agent", "Users", "Appearance"]);
    expect(await screen.findByText("email panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "AI agent" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "agent" }));
    expect(screen.getByText("agent panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Lead assignment" }));
    expect(await screen.findByText("assignment panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it("salespeople see Workspace, AI agent (message rules, read-only) and Appearance; Users by URL says admins only", async () => {
    mocks.isAdmin = false;
    await renderPage({ tab: "users" });
    expect(sections()).toEqual(["Workspace", "AI agent", "Appearance"]);
    expect(screen.getByText("Admins only")).toBeTruthy();
    expect(screen.queryByText("Create salesperson")).toBeNull();
  });

  it("the Google Calendar return (?calendar=connected) shows its toast on the Workspace tab", async () => {
    window.history.replaceState(null, "", "/settings?tab=workspace&calendar=connected");
    await renderPage({ tab: "workspace", calendar: "connected" });
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith("Google Calendar connected."),
    );
    expect(window.location.search).toBe("?tab=workspace");
    window.history.replaceState(null, "", "/");
  });

  it("Users (admins): today's Admin page — list, create, edit, deactivate", async () => {
    mocks.usersCreate.mockResolvedValue({});
    mocks.usersUpdate.mockResolvedValue({});
    await renderPage({ tab: "users" });
    expect(await screen.findByDisplayValue("Rep One")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(mocks.usersUpdate).toHaveBeenCalledWith("u-1", { active: false }));
    expect(screen.getByText("Create salesperson")).toBeTruthy();
  });

  it("Appearance sets the theme like the user menu", async () => {
    await renderPage({ tab: "appearance" });
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(mocks.setTheme).toHaveBeenCalledWith("dark");
  });
});
