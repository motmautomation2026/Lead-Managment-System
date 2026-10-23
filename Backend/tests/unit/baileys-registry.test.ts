import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  start: vi.fn(),
  constructed: [] as string[],
}));

vi.mock("../../src/db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/db.js")>()),
  pool: { query: mocks.poolQuery },
}));
vi.mock("../../src/providers/baileys.manager.js", () => ({
  BaileysManager: class {
    constructor(readonly workspaceId: string) {
      mocks.constructed.push(workspaceId);
    }
    isStopped = false;
    start = mocks.start;
    stop = vi.fn(async () => undefined);
  },
}));

import { BaileysManagerRegistry, startBackoffMs } from "../../src/providers/baileys-registry.js";
import { ProviderDeferredError } from "../../src/providers/provider-errors.js";

const WS = "ws-1";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  vi.clearAllMocks();
  mocks.constructed.length = 0;
  mocks.poolQuery.mockResolvedValue({ rows: [{ id: WS }] });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startBackoffMs", () => {
  it("doubles from 30s and caps at 10 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(startBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  });
});

describe("BaileysManagerRegistry start retries (B17)", () => {
  it("turns a failed start into ProviderDeferredError and logs the workspace", async () => {
    mocks.start.mockRejectedValueOnce(new Error("lock held"));
    const registry = new BaileysManagerRegistry();
    const error = await registry.getOrCreateManager(WS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderDeferredError);
    expect((error as Error).message).toBe("WhatsApp is starting up or recovering for this workspace.");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`workspace ${WS} (attempt 1`), expect.any(Error));
  });

  it("retries a failed start on a later ensure cycle, respecting the backoff", async () => {
    mocks.start.mockRejectedValueOnce(new Error("lock held")).mockResolvedValue(undefined);
    const registry = new BaileysManagerRegistry();

    await registry.ensureManagers();
    expect(mocks.start).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(29_999);
    await registry.ensureManagers();
    expect(mocks.start).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await registry.ensureManagers();
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(registry.getExistingManager(WS)).toBeDefined();
  });

  it("grows the backoff on repeated failures", async () => {
    mocks.start.mockRejectedValue(new Error("db down"));
    const registry = new BaileysManagerRegistry();

    await registry.ensureManagers(); // attempt 1 → 30s
    vi.advanceTimersByTime(30_000);
    await registry.ensureManagers(); // attempt 2 → 60s
    vi.advanceTimersByTime(59_999);
    await registry.ensureManagers();
    expect(mocks.start).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await registry.ensureManagers();
    expect(mocks.start).toHaveBeenCalledTimes(3);
  });

  it("resets the backoff after a successful start", async () => {
    mocks.start
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("c"));
    const registry = new BaileysManagerRegistry();
    await registry.ensureManagers();
    vi.advanceTimersByTime(30_000);
    await registry.ensureManagers();
    vi.advanceTimersByTime(60_000);
    await registry.ensureManagers();
    expect(registry.getExistingManager(WS)).toBeDefined();

    // A fresh failure after success starts again at attempt 1 (30s).
    await registry.stopAll();
    await registry.ensureManagers();
    expect(console.error).toHaveBeenLastCalledWith(expect.stringContaining("(attempt 1, retrying in 30s)"), expect.any(Error));
  });

  it("shares one in-flight start between concurrent callers", async () => {
    let finish!: () => void;
    mocks.start.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const registry = new BaileysManagerRegistry();
    const calls = [registry.getOrCreateManager(WS), registry.getOrCreateManager(WS), registry.ensureManagers()];
    finish();
    const [a, b] = await Promise.all(calls);
    expect(a).toBe(b);
    expect(mocks.constructed).toEqual([WS]);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("concurrent callers of a failing start all get ProviderDeferredError", async () => {
    let fail!: (e: Error) => void;
    mocks.start.mockReturnValueOnce(new Promise<void>((_resolve, reject) => (fail = reject)));
    const registry = new BaileysManagerRegistry();
    const calls = [registry.getOrCreateManager(WS), registry.getOrCreateManager(WS)].map((p) => p.catch((e: unknown) => e));
    fail(new Error("boom"));
    const errors = await Promise.all(calls);
    expect(errors.every((e) => e instanceof ProviderDeferredError)).toBe(true);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("callers during backoff get ProviderDeferredError without a new start", async () => {
    mocks.start.mockRejectedValueOnce(new Error("lock held"));
    const registry = new BaileysManagerRegistry();
    await registry.getOrCreateManager(WS).catch(() => undefined);
    vi.advanceTimersByTime(10_000);

    const error = await registry.getOrCreateManager(WS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderDeferredError);
    expect((error as ProviderDeferredError).retryAfterMs).toBe(20_000);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});

describe("BaileysManagerRegistry lock safety (B18)", () => {
  it("replaces a manager that stopped itself after losing its lock", async () => {
    mocks.start.mockResolvedValue(undefined);
    const registry = new BaileysManagerRegistry();
    const first = await registry.getOrCreateManager(WS);
    (first as unknown as { isStopped: boolean }).isStopped = true;

    await registry.ensureManagers();
    const second = registry.getExistingManager(WS);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it("refuses to start managers behind the port-6543 transaction pooler", async () => {
    const registry = new BaileysManagerRegistry("postgres://u:p@aws-0.pooler.supabase.com:6543/postgres");
    await registry.ensureManagers();
    await registry.ensureManagers();
    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("port 6543"));
    await expect(registry.getOrCreateManager(WS)).rejects.toBeInstanceOf(ProviderDeferredError);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });
});

describe("BaileysManagerRegistry.ensureManagers: only where needed, one at a time", () => {
  it("starts only the workspaces the query returns (whatsapp_connection needs a socket)", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    mocks.start.mockResolvedValue(undefined);
    const registry = new BaileysManagerRegistry();
    await registry.ensureManagers();
    expect(mocks.start).not.toHaveBeenCalled();
    const sql = String(mocks.poolQuery.mock.calls[0]![0]);
    expect(sql).toMatch(/whatsapp_connection/);
    expect(sql).toMatch(/w\.is_active/);
    expect(sql).toMatch(/desired_state in \('connected', 'restart'\)/);
  });

  it("starts managers sequentially: the next start waits for the previous one", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const finishers: ((fail?: boolean) => void)[] = [];
    mocks.start.mockImplementation(() => new Promise<void>((resolve, reject) => finishers.push((fail) => (fail ? reject(new Error("x")) : resolve()))));
    const registry = new BaileysManagerRegistry();
    const scan = registry.ensureManagers();

    await vi.waitFor(() => expect(mocks.constructed).toEqual(["a"]));
    finishers[0]!(true); // a failure moves on too
    await vi.waitFor(() => expect(mocks.constructed).toEqual(["a", "b"]));
    finishers[1]!();
    await vi.waitFor(() => expect(mocks.constructed).toEqual(["a", "b", "c"]));
    finishers[2]!();
    await scan;
    expect(registry.getExistingManager("a")).toBeUndefined();
    expect(registry.getExistingManager("b")).toBeDefined();
  });

  it("stops (and so closes the lock client of) a manager that is no longer needed", async () => {
    mocks.start.mockResolvedValue(undefined);
    const registry = new BaileysManagerRegistry();
    await registry.ensureManagers();
    const manager = registry.getExistingManager(WS) as unknown as { stop: ReturnType<typeof vi.fn> };
    expect(manager).toBeDefined();

    mocks.poolQuery.mockResolvedValue({ rows: [] });
    await registry.ensureManagers();
    expect(manager.stop).toHaveBeenCalledOnce();
    expect(registry.getExistingManager(WS)).toBeUndefined();
  });

  it("pairing: a workspace starts on the scan after its row asks for a connection; sends can still start one on demand", async () => {
    mocks.start.mockResolvedValue(undefined);
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    const registry = new BaileysManagerRegistry();
    await registry.ensureManagers();
    expect(mocks.start).not.toHaveBeenCalled();

    mocks.poolQuery.mockResolvedValue({ rows: [{ id: WS }] }); // Settings → Connect
    await registry.ensureManagers();
    expect(registry.getExistingManager(WS)).toBeDefined();

    expect(await registry.getOrCreateManager("ws-2")).toBeDefined(); // on demand, outside the scan
    expect(mocks.constructed).toEqual([WS, "ws-2"]);
  });
});
