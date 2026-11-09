/**
 * DB-3: clean shutdown for the API, the worker and scripts. On SIGINT (Ctrl+C,
 * also in PowerShell/CMD), SIGTERM or SIGBREAK (Windows Ctrl+Break) it runs
 * `close` once and exits 0; if `close` throws or takes longer than `timeoutMs`
 * it exits 1, so a hung socket can't keep pooler slots forever. A second signal
 * while closing is ignored (the hard timeout still applies).
 */
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;

interface ProcessLike {
  on(signal: string, listener: () => void): unknown;
  exit(code: number): void;
}

export function installShutdown(
  close: (signal: string) => Promise<void>,
  { timeoutMs = 10_000, proc = process as ProcessLike, log = console as Pick<Console, "log" | "error"> } = {},
): (signal: string) => Promise<void> {
  let closing = false;
  const run = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.log(`Received ${signal}, shutting down...`);
    const timer = setTimeout(() => {
      log.error(`Shutdown took longer than ${timeoutMs / 1000}s; exiting.`);
      proc.exit(1);
    }, timeoutMs);
    timer.unref?.();
    try {
      await close(signal);
      clearTimeout(timer);
      proc.exit(0);
    } catch (error) {
      clearTimeout(timer);
      log.error("Error during shutdown:", error instanceof Error ? error.message : String(error));
      proc.exit(1);
    }
  };
  for (const signal of SHUTDOWN_SIGNALS) proc.on(signal, () => void run(signal));
  return run;
}
