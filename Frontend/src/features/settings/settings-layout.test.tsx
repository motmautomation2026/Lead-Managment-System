import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  canManageUsers: true,
  isSuperAdmin: false,
  workspace: { id: "ws-1", name: "MOTM" } as { id: string; name: string } | null,
}));

vi.mock("@/store", () => ({
  useIsAdmin: () => mocks.isAdmin,
  useSession: () => ({
    canManageUsers: mocks.canManageUsers,
    isSuperAdmin: mocks.isSuperAdmin,
  }),
}));
vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({
    currentWorkspace: mocks.workspace,
    currentWorkspaceId: mocks.workspace?.id ?? null,
    isLoading: false,
  }),
}));

import { SettingsLayout } from "./settings-layout";
import { SettingsIndex } from "./settings-index";
import { AdminRedirect } from "./admin-redirect";
import {
  SETTINGS_SECTIONS,
  validateCalendarSearch,
  validateEmailSearch,
  validateSettingsIndexSearch,
} from "./settings-search";

afterEach(cleanup);
beforeEach(() => {
  mocks.isAdmin = true;
  mocks.canManageUsers = true;
  mocks.isSuperAdmin = false;
  mocks.workspace = { id: "ws-1", name: "MOTM" };
  // Desktop by default: /settings opens the default section.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width: 1024px"),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

/** The real layout + index + redirect, each section a stub that shows its id and search/hash. */
async function renderAt(path: string) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: SettingsLayout,
  });
  const sections = SETTINGS_SECTIONS.map((s) =>
    createRoute({
      getParentRoute: () => settings,
      path: s.id,
      ...(s.id === "email" ? { validateSearch: validateEmailSearch } : {}),
      ...(s.id === "calendar" ? { validateSearch: validateCalendarSearch } : {}),
      component: () => (
        <div>
          <h2>section {s.id}</h2>
          {s.id === "email" && <input id="email-dailyCap" aria-label="Daily cap" />}
        </div>
      ),
    }),
  );
  const router = createRouter({
    routeTree: root.addChildren([
      settings.addChildren([
        createRoute({
          getParentRoute: () => settings,
          path: "/",
          validateSearch: validateSettingsIndexSearch,
          component: SettingsIndex,
        }),
        ...sections,
      ]),
      createRoute({ getParentRoute: () => root, path: "/admin", component: AdminRedirect }),
      createRoute({ getParentRoute: () => root, path: "/knowledge", component: () => <h2>kb</h2> }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

const navLinks = () =>
  within(screen.getByRole("navigation", { name: "Settings sections" }))
    .getAllByRole("link")
    .map((a) => a.textContent);

describe("Settings layout (UX-1)", () => {
  it("one route per section: the sub-nav opens a section and Back returns", async () => {
    const router = await renderAt("/settings");
    await screen.findByRole("heading", { name: "section email" });
    expect(router.state.location.pathname).toBe("/settings/email");
    fireEvent.click(screen.getByRole("link", { name: "WhatsApp" }));
    await screen.findByRole("heading", { name: "section whatsapp" });
    expect(screen.getByRole("link", { name: "WhatsApp" })).toHaveAttribute("aria-current", "page");
    router.history.back();
    await screen.findByRole("heading", { name: "section email" });
  });

  it("a salesperson sees only what they can use (hidden, not disabled)", async () => {
    mocks.isAdmin = false;
    mocks.canManageUsers = false;
    await renderAt("/settings/email");
    await screen.findByRole("heading", { name: "section email" });
    expect(navLinks()).toEqual([
      "Email",
      "WhatsApp",
      "Google Calendar",
      "Message rules",
      "Knowledge & assets",
      "My profile",
      "Appearance",
    ]);
  });

  it("an admin gets Workspace, AI and User accounts; only a super-admin gets All workspaces and System health", async () => {
    await renderAt("/settings/email");
    await screen.findByRole("heading", { name: "section email" });
    expect(navLinks()).toContain("Team");
    expect(navLinks()).toContain("Playbook");
    expect(navLinks()).toContain("User accounts");
    expect(navLinks()).not.toContain("All workspaces");
    cleanup();
    mocks.isSuperAdmin = true;
    await renderAt("/settings/email");
    await screen.findByRole("heading", { name: "section email" });
    expect(navLinks()).toContain("All workspaces");
    expect(navLinks()).toContain("System health");
  });

  it("a section the viewer can't open, by URL, says No access and loads nothing", async () => {
    mocks.isAdmin = false;
    mocks.canManageUsers = false;
    await renderAt("/settings/team");
    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "section team" })).toBeNull();
  });

  it("workspace sections need a selected workspace; personal ones don't", async () => {
    mocks.workspace = null;
    await renderAt("/settings/email");
    expect(await screen.findByText("No workspace is selected")).toBeInTheDocument();
    cleanup();
    await renderAt("/settings/profile");
    expect(await screen.findByRole("heading", { name: "section profile" })).toBeInTheDocument();
  });

  it("search finds a setting by name and jumps to its tab and field", async () => {
    const router = await renderAt("/settings/profile");
    await screen.findByRole("heading", { name: "section profile" });
    const box = screen.getByRole("combobox", { name: "Search settings" });
    fireEvent.change(box, { target: { value: "daily cap" } });
    const option = screen.getByRole("option", { name: /Email daily cap/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByRole("heading", { name: "section email" });
    expect(router.state.location.search).toEqual({ tab: "safety" });
    expect(router.state.location.hash).toBe("email-dailyCap");
    await waitFor(() => expect(screen.getByLabelText("Daily cap")).toHaveFocus());
  });

  it("search never lists sections the viewer can't open", async () => {
    mocks.isAdmin = false;
    mocks.canManageUsers = false;
    await renderAt("/settings/email");
    fireEvent.change(await screen.findByRole("combobox", { name: "Search settings" }), {
      target: { value: "playbook" },
    });
    expect(screen.getByText("No setting found.")).toBeInTheDocument();
  });

  it("old URLs redirect: /settings?tab=… and /admin (with the Calendar OAuth query)", async () => {
    let router = await renderAt("/settings?tab=agent");
    await screen.findByRole("heading", { name: "section ai-agent" });
    cleanup();
    router = await renderAt("/settings?tab=workspace&calendar=connected");
    await screen.findByRole("heading", { name: "section calendar" });
    expect(router.state.location.search).toEqual({ calendar: "connected" });
    cleanup();
    router = await renderAt("/admin");
    await screen.findByRole("heading", { name: "section users" });
    expect(router.state.location.pathname).toBe("/settings/users");
  });

  it("phones: /settings is the section list; a section has a back link", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const router = await renderAt("/settings");
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(nav).not.toHaveClass("hidden");
    expect(router.state.location.pathname).toBe("/settings");
    fireEvent.click(within(nav).getByRole("link", { name: "Email" }));
    await screen.findByRole("heading", { name: "section email" });
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toHaveClass("hidden");
    fireEvent.click(screen.getByRole("link", { name: "All settings" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
  });
});
