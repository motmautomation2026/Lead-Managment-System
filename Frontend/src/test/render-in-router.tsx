import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

/**
 * Renders a section at `/page` (plus `/elsewhere`) with a QueryClient: sections read `?tab=` and their
 * SaveBar guards leaving, so they need a router.
 */
export async function renderInRouter(
  ui: () => ReactNode,
  {
    search = "",
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  }: { search?: string; client?: QueryClient } = {},
) {
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/page", component: ui }),
      createRoute({
        getParentRoute: () => root,
        path: "/elsewhere",
        component: () => <h1>Elsewhere</h1>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [`/page${search}`] }),
  });
  await router.load();
  const result = render(<RouterProvider router={router} />);
  return { router, client, ...result };
}
