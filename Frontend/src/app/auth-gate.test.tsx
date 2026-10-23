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
      page("/admin", "admin page"),
      page("/settings", "settings"),
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

  it("renders /admin inside the shell for an admin", async () => {
    mocks.role = "admin";
    await renderAt("/admin");
    expect(await screen.findByText("admin page")).toBeTruthy();
    expect(screen.getByTestId("shell")).toBeTruthy();
  });

  it("redirects a salesperson from /admin to /", async () => {
    mocks.role = "salesperson";
    const router = await renderAt("/admin");
    expect(await screen.findByText("dashboard")).toBeTruthy();
    expect(screen.queryByText("admin page")).toBeNull();
    expect(router.state.location.pathname).toBe("/");
  });

  it.each(["admin", "salesperson"] as const)(
    "forwards the Google Calendar return (?calendar=) to /settings for an %s",
    async (role) => {
      mocks.role = role;
      const replace = vi.fn();
      vi.stubGlobal("location", { ...window.location, search: "?calendar=connected", replace });
      await renderAt("/admin");
      await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/settings?calendar=connected"));
      expect(screen.queryByText("admin page")).toBeNull();
    },
  );
});
