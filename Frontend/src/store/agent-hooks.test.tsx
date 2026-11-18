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
  decisionsList: vi.fn(),
  rate: vi.fn(),
  enroll: vi.fn(),
  pause: vi.fn(),
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
      decisions: { list: mocks.decisionsList, rate: mocks.rate },
      leads: { enroll: mocks.enroll, pause: mocks.pause },
    },
  },
}));

import { keys } from "./query";
import {
  useAgentDecisions,
  useEnrollLeads,
  usePauseLead,
  useRateDecision,
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

describe("AI review hooks", () => {
  const invalidatedKeys = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((call) => (call[0] as { queryKey: unknown }).queryKey);

  it("useAgentDecisions loads pages on the cursor: Load more fetches the next cursor", async () => {
    mocks.decisionsList
      .mockResolvedValueOnce({ data: [{ id: "d1" }], nextCursor: "c1" })
      .mockResolvedValueOnce({ data: [{ id: "d2" }], nextCursor: null });
    const { wrapper } = setup();
    const filters = { rating: "unrated" as const };
    const { result } = renderHook(() => useAgentDecisions(filters), { wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    expect(mocks.decisionsList).toHaveBeenLastCalledWith(filters, undefined, expect.anything());

    await act(() => result.current.fetchNextPage());
    expect(mocks.decisionsList).toHaveBeenLastCalledWith(filters, "c1", expect.anything());
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(result.current.data?.pages.flatMap((p) => p.data.map((d) => d.id))).toEqual([
      "d1",
      "d2",
    ]);
  });

  it("a rating invalidates the decision, every decisions list, stats and the lead panels", async () => {
    mocks.rate.mockResolvedValue({ id: "d1", rating: "good" });
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRateDecision(), { wrapper });
    await act(() => result.current.mutateAsync({ id: "d1", input: { rating: "good" } }));
    expect(mocks.rate).toHaveBeenCalledWith("d1", { rating: "good" });
    expect(invalidatedKeys(invalidate)).toEqual([
      keys.agentDecision("ws-1", "d1"),
      keys.agentDecisions("ws-1"),
      keys.agentStats("ws-1"),
      keys.agentLeadPanel("ws-1"),
    ]);
  });

  it("enroll sends 250 ids as 100/100/50 and returns every result", async () => {
    mocks.enroll.mockImplementation(async (ids: string[]) => ({
      data: ids.map((leadId) => ({ leadId, result: "enrolled" })),
    }));
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const ids = Array.from({ length: 250 }, (_, i) => `lead-${i}`);
    const { result } = renderHook(() => useEnrollLeads(), { wrapper });
    const results = await act(() => result.current.mutateAsync(ids));
    expect(mocks.enroll.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 50]);
    expect(mocks.enroll.mock.calls.flatMap(([chunk]) => chunk)).toEqual(ids);
    expect(results).toHaveLength(250);
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([
        keys.contacts("ws-1"),
        keys.agentLeadPanel("ws-1"),
        keys.agentStats("ws-1"),
      ]),
    );
  });

  it("pausing a lead refreshes that lead, its panel and stats", async () => {
    mocks.pause.mockResolvedValue({ id: "lead-1" });
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => usePauseLead(), { wrapper });
    await act(() => result.current.mutateAsync("lead-1"));
    expect(mocks.pause).toHaveBeenCalledWith("lead-1");
    expect(invalidatedKeys(invalidate)).toEqual(
      expect.arrayContaining([
        keys.lead("ws-1", "lead-1"),
        keys.contacts("ws-1"),
        keys.agentLeadPanel("ws-1", "lead-1"),
        keys.contact("ws-1", "lead-1"),
        keys.agentStats("ws-1"),
      ]),
    );
  });
});
