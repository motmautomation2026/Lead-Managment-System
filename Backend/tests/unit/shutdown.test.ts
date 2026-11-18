import { afterEach, describe, expect, it, vi } from "vitest";
import { installShutdown, SHUTDOWN_SIGNALS } from "../../src/shutdown.js";

function fakeProcess() {
  const listeners = new Map<string, () => void>();
  return { listeners, on: vi.fn((signal: string, fn: () => void) => listeners.set(signal, fn)), exit: vi.fn() };
}
const log = { log: vi.fn(), error: vi.fn() };

describe("installShutdown", () => {
  afterEach(() => vi.useRealTimers());

  it("listens to SIGINT, SIGTERM and SIGBREAK (Windows Ctrl+Break)", () => {
    const proc = fakeProcess();
    installShutdown(async () => undefined, { proc, log });
    expect([...proc.listeners.keys()]).toEqual([...SHUTDOWN_SIGNALS]);
    expect(SHUTDOWN_SIGNALS).toEqual(["SIGINT", "SIGTERM", "SIGBREAK"]);
  });

  it("closes once and exits 0, ignoring a second signal", async () => {
    const proc = fakeProcess();
    const close = vi.fn(async () => undefined);
    const run = installShutdown(close, { proc, log });
    await Promise.all([run("SIGINT"), run("SIGTERM")]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("exits 1 when closing fails", async () => {
    const proc = fakeProcess();
    await installShutdown(async () => Promise.reject(new Error("boom")), { proc, log })("SIGTERM");
    expect(proc.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("exits 1 after the hard timeout when closing hangs", async () => {
    vi.useFakeTimers();
    const proc = fakeProcess();
    void installShutdown(() => new Promise<void>(() => undefined), { proc, log, timeoutMs: 10_000 })("SIGINT");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(proc.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
