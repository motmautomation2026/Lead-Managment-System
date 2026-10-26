import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { TaskListItem } from "@/types";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class extends Error {},
  backend: { tasks: { complete: mocks.complete } },
}));
vi.mock("./workspace-context", () => ({ useWorkspace: () => ({ currentWorkspaceId: "ws-1" }) }));

import { useCompleteTask } from "./work-hooks";
import { keys } from "./query";

const task = { id: "t-1", status: "open", done: false, title: "Call" } as TaskListItem;
const listKey = keys.workList("ws-1", "tasks", { ownerId: ["me"] });

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(listKey, {
    pages: [{ data: [task], nextCursor: null }],
    pageParams: [undefined],
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useCompleteTask(), { wrapper });
  const row = () =>
    (client.getQueryData(listKey) as { pages: { data: TaskListItem[] }[] }).pages[0]!.data[0]!;
  return { result, row };
}

describe("useCompleteTask", () => {
  it("marks the row completed at once, before the request returns", async () => {
    let resolve!: (v: unknown) => void;
    mocks.complete.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result, row } = setup();
    act(() => result.current.mutate("t-1"));
    await waitFor(() => expect(row().status).toBe("completed"));
    expect(row().done).toBe(true);
    await act(async () => resolve({ ...task, status: "completed" }));
  });

  it("restores the row when the request fails", async () => {
    mocks.complete.mockRejectedValue(new Error("Only an open task…"));
    const { result, row } = setup();
    act(() => result.current.mutate("t-1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(row().status).toBe("open");
    expect(row().done).toBe(false);
  });
});
