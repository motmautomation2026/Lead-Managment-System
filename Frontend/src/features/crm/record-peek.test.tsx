import { cleanup, render, screen } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRecents } from "@/lib/recent-records";

vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("./activity-feed", () => ({ ActivityFeed: () => <div>feed</div> }));
vi.mock("@/app/add-lead-context", () => ({ useCreateTaskDialog: () => ({ open: vi.fn() }) }));
vi.mock("@/store", () => ({
  messageFromError: () => "Failed",
  useLeadMutations: () => ({ addNote: vi.fn() }),
  useContact: () => ({ data: undefined, isLoading: false, error: null }),
  useCompany: () => ({
    data: {
      id: "co-7",
      name: "Acme Steel",
      domain: null,
      industry: null,
      city: null,
      owner: null,
      contactCount: 2,
      openDealCount: 0,
      openDealAmount: 0,
    },
    isLoading: false,
    error: null,
  }),
  useDeal: () => ({ data: undefined, isLoading: false, error: null }),
}));

import RecordPeek from "./record-peek";

afterEach(cleanup);

describe("RecordPeek (UX-3 rule 4)", () => {
  it("a record opened from a peek joins the palette's Recent list", async () => {
    window.localStorage.clear();
    const root = createRootRoute({ component: () => <Outlet /> });
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({
          getParentRoute: () => root,
          path: "/",
          component: () => <RecordPeek type="company" id="co-7" onClose={() => undefined} />,
        }),
        createRoute({ getParentRoute: () => root, path: "/companies/$id", component: () => null }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    render(<RouterProvider router={router} />);
    expect(await screen.findByText("feed")).toBeTruthy();
    expect(readRecents("ws-1")).toEqual([{ type: "company", id: "co-7", label: "Acme Steel" }]);
  });
});
