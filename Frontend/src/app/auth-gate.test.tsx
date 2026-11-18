import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: "salesperson" as "admin" | "salesperson",
  workspaces: [{ id: "ws-1", name: "MOTM", role: "salesperson" }] as {
    id: string;
    name: string;
    role: string;
  }[],
}));

vi.mock("@/lib/use-supabase-session", () => ({
  useSupabaseSession: () => ({ loading: false, session: { user: { id: "user-1" } } }),
}));
vi.mock("@/lib/supabase-client", () => ({ configurationError: null, supabase: null }));
vi.mock("@/features/auth/login-page", () => ({ LoginPage: () => <div>login</div> }));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class extends Error {},
  backend: {
    me: async () => ({
      id: "user-1",
      name: "U",
      email: "u@example.com",
      role: mocks.role,
      workspaces: mocks.workspaces,
    }),
  },
}));
vi.mock("@/store", () => ({ StoreProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/app/app-shell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-testid="shell">{children}</div>,
}));

import { AuthGate } from "@/app/auth-gate";
import { AdminRedirect } from "@/features/settings/admin-redirect";
import { validateCalendarSearch } from "@/features/settings/settings-search";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.workspaces = [{ id: "ws-1", name: "MOTM", role: "salesperson" }];
  window.history.replaceState({}, "", "/");
});

async function renderAt(path: string) {
  const queryClient = new QueryClient();
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <AuthGate queryClient={queryClient}>
          <Outlet />
        </AuthGate>
      </QueryClientProvider>
    ),
  });
  const page = (path: string, text: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => <div>{text}</div> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      page("/", "dashboard"),
      createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: AdminRedirect }),
      page("/settings/users", "settings"),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings/calendar",
        validateSearch: validateCalendarSearch,
        component: () => <div>settings</div>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

describe("AuthGate", () => {
  it("gives an admin the shell on CRM pages (no redirect to /admin)", async () => {
    mocks.role = "admin";
    const router = await renderAt("/");
    expect(await screen.findByText("dashboard")).toBeTruthy();
    expect(screen.getByTestId("shell")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
  });

  it("sends an admin from /admin to Settings → User accounts (C6b, UX-1)", async () => {
    mocks.role = "admin";
    const router = await renderAt("/admin");
    expect(await screen.findByText("settings")).toBeTruthy();
    expect(screen.getByTestId("shell")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/users");
  });

  it("redirects a salesperson from /admin to /", async () => {
    mocks.role = "salesperson";
    const router = await renderAt("/admin");
    expect(await screen.findByText("dashboard")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
  });

  it.each(["admin", "salesperson"] as const)(
    "sends the Google Calendar return (/admin?calendar=) to Settings → Google Calendar with the same query, for an %s",
    async (role) => {
      mocks.role = role;
      vi.stubGlobal("location", { ...window.location, search: "?calendar=error&message=Denied" });
      const router = await renderAt("/admin?calendar=error&message=Denied");
      expect(await screen.findByText("settings")).toBeTruthy();
      expect(router.state.location.pathname).toBe("/settings/calendar");
      expect(router.state.location.search).toEqual({
        calendar: "error",
        message: "Denied",
      });
    },
  );

  it("E4b: a user with no workspace gets the plain message, not the app", async () => {
    mocks.workspaces = [];
    await renderAt("/");
    expect(
      await screen.findByRole("heading", {
        name: "You haven't been added to a workspace yet. Ask your admin.",
      }),
    ).toBeTruthy();
    expect(screen.queryByTestId("shell")).toBeNull();
  });

  it("E4b: a workspace link the user may not open says so; an allowed one opens the app", async () => {
    window.history.replaceState({}, "", "/?workspace=ws-other");
    await renderAt("/");
    expect(
      await screen.findByRole("heading", { name: "You don't have access to this workspace" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to my workspaces" }).getAttribute("href")).toBe(
      "/",
    );
    cleanup();
    window.history.replaceState({}, "", "/?workspace=ws-1");
    await renderAt("/");
    expect(await screen.findByTestId("shell")).toBeTruthy();
  });
});
