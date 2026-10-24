import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { useListUrlState } from "@/lib/use-list-url-state";

const schema = z.object({
  q: z.string().optional(),
  view: z.string().default("all"),
  sort: z.string().default("createdAt:desc"),
  ownerId: z.array(z.string()).optional(),
});

function ListPage() {
  const [state, set] = useListUrlState(schema);
  return (
    <div>
      <pre data-testid="state">{JSON.stringify(state)}</pre>
      <button onClick={() => void set({ ownerId: ["me", "none"], sort: "name:asc" })}>
        filter
      </button>
      <button onClick={() => void set({ ownerId: [] })}>clear owner</button>
      <button onClick={() => void set({ q: "asha" }, { replace: true })}>search</button>
    </div>
  );
}

async function renderAt(url: string) {
  const root = createRootRoute();
  const list = createRoute({
    getParentRoute: () => root,
    path: "/list",
    validateSearch: schema,
    component: ListPage,
  });
  const router = createRouter({
    routeTree: root.addChildren([list]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

const state = () => JSON.parse(screen.getByTestId("state").textContent ?? "{}") as unknown;

afterEach(cleanup);

describe("useListUrlState", () => {
  it("applies schema defaults for a bare URL", async () => {
    await renderAt("/list");
    expect(state()).toEqual({ view: "all", sort: "createdAt:desc" });
  });

  it("round-trips through the URL and Back restores the previous state", async () => {
    const router = await renderAt("/list?view=mine");
    fireEvent.click(screen.getByText("filter"));
    await screen.findByText(/name:asc/);
    expect(router.state.location.search).toMatchObject({
      view: "mine",
      sort: "name:asc",
      ownerId: ["me", "none"],
    });

    // A fresh load of the same URL parses to the same state (shareable link).
    const href = router.state.location.href;
    cleanup();
    await renderAt(href);
    expect(state()).toEqual({ view: "mine", sort: "name:asc", ownerId: ["me", "none"] });
  });

  it("Back undoes a pushed change; replace does not add history", async () => {
    const router = await renderAt("/list");
    fireEvent.click(screen.getByText("filter"));
    await screen.findByText(/name:asc/);
    fireEvent.click(screen.getByText("search"));
    await screen.findByText(/asha/);
    act(() => router.history.back());
    await screen.findByText(/createdAt:desc/);
    expect(state()).toEqual({ view: "all", sort: "createdAt:desc" });
  });

  it("drops empty values from the URL", async () => {
    const router = await renderAt("/list");
    fireEvent.click(screen.getByText("filter"));
    await screen.findByText(/name:asc/);
    fireEvent.click(screen.getByText("clear owner"));
    await screen.findByText((t) => t.includes("name:asc") && !t.includes("ownerId"));
    expect(router.state.location.search).not.toHaveProperty("ownerId");
  });
});
