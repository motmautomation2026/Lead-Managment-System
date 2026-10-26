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

const mocks = vi.hoisted(() => ({ role: "salesperson" as "admin" | "salesperson" }));

vi.mock("@/lib/use-supabase-session", () => ({
  useSupabaseSession: () => ({ loading: false, session: { user: { id: "user-1" } } }),
}));
vi.mock("@/lib/supabase-client", () => ({ configurationError: null }));
vi.mock("@/features/auth/login-page", () => ({ LoginPage: () => <div>login</div> }));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class extends Error {},
  backend: {
    me: async () => ({ id: "user-1", name: "U", email: "u@example.com", role: mocks.role }),
  },
}));
vi.mock("@/store", () => ({ StoreProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/app/app-shell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-testid="shell">{children}</div>,
}));

import { AuthGate } from "@/app/auth-gate";
import { AdminRedirect } from "@/features/settings/admin-redirect";
import { validateSettingsSearch } from "@/features/settings/settings-search";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings",
        validateSearch: validateSettingsSearch,
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

  it("sends an admin from /admin to Settings → Users (C6b)", async () => {
    mocks.role = "admin";
    const router = await renderAt("/admin");
    expect(await screen.findByText("settings")).toBeTruthy();
    expect(screen.getByTestId("shell")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings");
    expect(router.state.location.search).toEqual({ tab: "users" });
  });

  it("redirects a salesperson from /admin to /", async () => {
    mocks.role = "salesperson";
    const router = await renderAt("/admin");
    expect(await screen.findByText("dashboard")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
  });

  it.each(["admin", "salesperson"] as const)(
    "sends the Google Calendar return (/admin?calendar=) to Settings → Workspace with the same query, for an %s",
    async (role) => {
      mocks.role = role;
      vi.stubGlobal("location", { ...window.location, search: "?calendar=error&message=Denied" });
      const router = await renderAt("/admin?calendar=error&message=Denied");
      expect(await screen.findByText("settings")).toBeTruthy();
      expect(router.state.location.pathname).toBe("/settings");
      expect(router.state.location.search).toEqual({
        tab: "workspace",
        calendar: "error",
        message: "Denied",
      });
    },
  );
});
