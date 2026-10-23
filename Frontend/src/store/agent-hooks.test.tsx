import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  settingsUpdate: vi.fn(),
  playbooksList: vi.fn(),
  playbookCreate: vi.fn(),
  playbookRestore: vi.fn(),
}));

vi.mock("./workspace-context", () => ({ useWorkspace: () => ({ currentWorkspaceId: "ws-1" }) }));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class extends Error {},
  backend: {
    agent: {
      settings: { get: mocks.settingsGet, update: mocks.settingsUpdate },
      playbooks: {
        list: mocks.playbooksList,
        create: mocks.playbookCreate,
        restore: mocks.playbookRestore,
      },
    },
  },
}));

import { keys } from "./query";
import {
  useAgentPlaybooks,
  useAgentSettings,
  useRestorePlaybook,
  useSavePlaybook,
  useUpdateAgentSettings,
} from "./server-hooks";

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(() => vi.clearAllMocks());

describe("agent hooks", () => {
  it("load settings and playbooks under workspace-scoped keys", async () => {
    mocks.settingsGet.mockResolvedValue({ mode: "off" });
    mocks.playbooksList.mockResolvedValue({ currentVersion: null, data: [] });
    const { client, wrapper } = setup();
    const settings = renderHook(() => useAgentSettings(), { wrapper });
    const playbooks = renderHook(() => useAgentPlaybooks(), { wrapper });
    await waitFor(() => expect(settings.result.current.data).toEqual({ mode: "off" }));
    await waitFor(() => expect(playbooks.result.current.data?.currentVersion).toBeNull());
    expect(client.getQueryData(keys.agentSettings("ws-1"))).toEqual({ mode: "off" });
    expect(keys.agentPlaybooks("ws-1")).toEqual(["agentPlaybooks", "ws-1"]);
  });

  it("a settings update writes the saved settings into the cache", async () => {
    mocks.settingsUpdate.mockResolvedValue({ mode: "shadow" });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useUpdateAgentSettings(), { wrapper });
    await act(() => result.current.mutateAsync({ mode: "shadow" }));
    expect(mocks.settingsUpdate).toHaveBeenCalledWith({ mode: "shadow" });
    expect(client.getQueryData(keys.agentSettings("ws-1"))).toEqual({ mode: "shadow" });
  });

  it("saving or restoring a playbook invalidates playbooks and settings", async () => {
    mocks.playbookCreate.mockResolvedValue({ version: 1 });
    mocks.playbookRestore.mockResolvedValue({ version: 2 });
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const save = renderHook(() => useSavePlaybook(), { wrapper });
    const restore = renderHook(() => useRestorePlaybook(), { wrapper });

    await act(() => save.result.current.mutateAsync("Body"));
    await act(() => restore.result.current.mutateAsync(1));

    expect(mocks.playbookCreate).toHaveBeenCalledWith("Body");
    expect(mocks.playbookRestore).toHaveBeenCalledWith(1);
    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(invalidated).toEqual([
      keys.agentPlaybooks("ws-1"),
      keys.agentSettings("ws-1"),
      keys.agentPlaybooks("ws-1"),
      keys.agentSettings("ws-1"),
    ]);
  });
});
