import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bulk: vi.fn(),
  count: vi.fn(),
  enrollRun: vi.fn(),
  empty: vi.fn(),
}));

vi.mock("./workspace-context", () => ({ useWorkspace: () => ({ currentWorkspaceId: "ws-1" }) }));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class extends Error {},
  backend: {
    contacts: { bulk: mocks.bulk, count: mocks.count },
    runs: { list: mocks.empty, create: mocks.enrollRun },
    workflows: { list: mocks.empty },
    templates: { list: mocks.empty },
    scheduledActions: { list: mocks.empty },
  },
}));

import { keys } from "./query";
import { useAutomations, useBulkContacts, useContactsCount } from "./server-hooks";

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
const invalidatedKeys = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);

afterEach(() => vi.clearAllMocks());

describe("contact hooks", () => {
  it("B31: enrolling in a workflow also refreshes the contact (record, timeline, tasks, lists)", async () => {
    mocks.empty.mockResolvedValue({ data: [] });
    mocks.enrollRun.mockResolvedValue({ data: [] });
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useAutomations(), { wrapper });
    await act(() => result.current.enrollLead("lead-1", "wf-1"));
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([
        keys.runs("ws-1"),
        keys.contact("ws-1", "lead-1"),
        keys.lead("ws-1", "lead-1"),
        keys.timeline("ws-1", "lead-1"),
        keys.tasks("ws-1"),
        keys.contacts("ws-1"),
      ]),
    );
  });

  it("bulk sends at most 100 ids per request and returns every result", async () => {
    mocks.bulk.mockImplementation(({ ids }: { ids: string[] }) =>
      Promise.resolve({ data: ids.map((id) => ({ id, ok: true })) }),
    );
    const { wrapper } = setup();
    const { result } = renderHook(() => useBulkContacts(), { wrapper });
    const ids = Array.from({ length: 150 }, (_, i) => `c${i}`);
    let results: unknown[] = [];
    await act(async () => {
      results = await result.current.mutateAsync({ ids, action: "assignOwner", ownerId: "u1" });
    });
    expect(mocks.bulk).toHaveBeenCalledTimes(2);
    expect(mocks.bulk.mock.calls[0]![0].ids).toHaveLength(100);
    expect(mocks.bulk.mock.calls[1]![0]).toMatchObject({ action: "assignOwner", ownerId: "u1" });
    expect(results).toHaveLength(150);
  });

  it("count sends the list filters without sort", async () => {
    mocks.count.mockResolvedValue({ count: 3 });
    const { wrapper } = setup();
    const { result } = renderHook(() => useContactsCount({ ownerId: ["me"], sort: "name:asc" }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toEqual({ count: 3 }));
    expect(mocks.count.mock.calls[0]![0]).toEqual({ ownerId: ["me"] });
  });
});
