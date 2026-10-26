import { cleanup, render, screen } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";
import { RoutePending } from "@/app/route-pending";

afterEach(cleanup);

// Production splits each route component into its own chunk (vite autoCodeSplitting);
// the router shows RoutePending until the chunk arrives.
describe("lazy routes", () => {
  it("show the page skeleton while the chunk loads, then the page", async () => {
    let load: (mod: { Page: () => React.ReactNode }) => void = () => undefined;
    const chunk = new Promise<{ Page: () => React.ReactNode }>((resolve) => (load = resolve));
    const root = createRootRoute({ component: () => <Outlet /> });
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({
          getParentRoute: () => root,
          path: "/",
          component: lazyRouteComponent(() => chunk, "Page"),
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      defaultPendingComponent: RoutePending,
      defaultPendingMs: 0,
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("status", { name: "Loading page" })).toBeTruthy();
    load({ Page: () => <h1>Companies</h1> });
    expect(await screen.findByRole("heading", { name: "Companies" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading page" })).toBeNull();
  });
});
