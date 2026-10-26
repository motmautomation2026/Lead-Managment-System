import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "@/components/crm/data-table";
import { keys } from "@/store/query";

const mocks = vi.hoisted(() => ({
  contact: vi.fn(),
  deal: vi.fn(),
}));

vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/lib/backend-client", () => ({
  backend: {
    contacts: { get: mocks.contact },
    companies: { get: vi.fn() },
    deals: { get: mocks.deal },
  },
}));

import { RecordLink } from "./record-link";
import { usePrefetchRecord } from "./prefetch";

function Table() {
  const prefetch = usePrefetchRecord();
  return (
    <DataTable
      label="Deals"
      data={[
        { id: "d-1", name: "Fleet renewal" },
        { id: "d-2", name: "Depot rollout" },
      ]}
      columns={[{ id: "name", header: "Name", cell: (r) => r.name }]}
      getRowId={(r) => r.id}
      onRowIntent={(r) => prefetch("deal", r.id)}
    />
  );
}

function renderWith(ui: React.ReactNode) {
  const client = new QueryClient();
  const root = createRootRoute({
    component: () => (
      <>
        {ui}
        <Outlet />
      </>
    ),
  });
  const routes = ["/contacts/$contactId", "/companies/$companyId", "/deals/$dealId"].map((path) =>
    createRoute({ getParentRoute: () => root, path, component: () => <p>record</p> }),
  );
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([index, ...routes]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient: client },
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("record prefetch on intent", () => {
  it("hovering a record link loads the record query into the record page's key (once while fresh)", async () => {
    mocks.contact.mockResolvedValue({ id: "c-1", name: "Asha Rao" });
    const { client } = renderWith(
      <RecordLink type="contact" id="c-1">
        Asha Rao
      </RecordLink>,
    );
    const link = await screen.findByRole("link", { name: "Asha Rao" });
    expect(link).toHaveAttribute("href", "/contacts/c-1");
    fireEvent.pointerEnter(link, { pointerType: "mouse" });
    await waitFor(() =>
      expect(client.getQueryData(keys.contact("ws-1", "c-1"))).toEqual({
        id: "c-1",
        name: "Asha Rao",
      }),
    );
    fireEvent.focus(link);
    fireEvent.pointerEnter(link, { pointerType: "mouse" });
    expect(mocks.contact).toHaveBeenCalledTimes(1);
  });

  it("touch pointers don't prefetch (they fire while scrolling)", async () => {
    renderWith(
      <RecordLink type="contact" id="c-2">
        Ravi
      </RecordLink>,
    );
    fireEvent.pointerEnter(await screen.findByRole("link", { name: "Ravi" }), {
      pointerType: "touch",
    });
    expect(mocks.contact).not.toHaveBeenCalled();
  });

  it("DataTable rows prefetch on hover and on keyboard focus", async () => {
    mocks.deal.mockImplementation((id: string) => Promise.resolve({ id }));
    const { client } = renderWith(<Table />);
    const row = (await screen.findByText("Fleet renewal")).closest("tr")!;
    fireEvent.pointerEnter(row, { pointerType: "pen" });
    await waitFor(() => expect(client.getQueryData(keys.deal("ws-1", "d-1"))).toBeTruthy());
    expect(mocks.deal).toHaveBeenCalledWith("d-1");
    fireEvent.focus(screen.getByText("Depot rollout").closest("tr")!);
    await waitFor(() => expect(mocks.deal).toHaveBeenCalledWith("d-2"));
  });
});
