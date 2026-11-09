import { databaseUrls, pool, sessionLockUnsupportedReason } from "../db.js";
import { BaileysManager } from "./baileys.manager.js";
import { ProviderDeferredError } from "./provider-errors.js";

const START_BACKOFF_BASE_MS = 30_000;
const START_BACKOFF_MAX_MS = 10 * 60_000;
const RECOVERING_MESSAGE = "WhatsApp is starting up or recovering for this number.";

/**
 * E4a: WhatsApp numbers of active workspaces that need a running manager (one session-lock
 * client each): an admin wants the number connected (desired_state 'connected' or 'restart',
 * which covers pairing and a paired number) and it isn't removed, or it was told to disconnect
 * (incl. removal) while a socket may still be live (status connecting / qr_ready / connected /
 * reconnecting), so the manager can log out. Everything else needs nothing.
 */
const NEEDS_MANAGER_SQL = `
  select n.id, n.workspace_id, w.name as workspace_name
    from public.whatsapp_numbers n
    join public.workspaces w on w.id = n.workspace_id
   where w.is_active
     and ((n.removed_at is null and n.desired_state in ('connected', 'restart'))
          or n.status in ('connecting', 'qr_ready', 'connected', 'reconnecting'))
   order by n.workspace_id, n.created_at, n.id`;

interface NeededNumber {
  id: string;
  workspace_id: string;
  workspace_name: string;
}

/** Wait before retrying a number whose manager failed to start `attempts` times in a row: 30s × 2^(n-1), capped at 10 min. */
export function startBackoffMs(attempts: number): number {
  return Math.min(START_BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), START_BACKOFF_MAX_MS);
}

/** "MOTM: 2, MOTM Tech: 1 → 3 session-pooler slots" — the startup / change log line (rule 12). */
export function describeNeededNumbers(rows: NeededNumber[]): string {
  const perWorkspace = new Map<string, number>();
  for (const row of rows) perWorkspace.set(row.workspace_name, (perWorkspace.get(row.workspace_name) ?? 0) + 1);
  const list = [...perWorkspace].map(([name, count]) => `${name}: ${count}`).join(", ") || "none";
  return `WhatsApp numbers with a session: ${list} → ${rows.length} session-pooler slot(s) (one lock client per number).`;
}

/**
 * One BaileysManager per WhatsApp NUMBER (E4a: a workspace has 1…N numbers).
 * The worker process is still a single Node process/poll loop; this registry
 * is what lets that one process hold N independent Baileys sockets, each with
 * its own Postgres advisory lock (keyed by the number id) so a second worker
 * process can never double-own the same number's session.
 */
export class BaileysManagerRegistry {
  private readonly managers = new Map<string, BaileysManager>();
  private readonly starting = new Map<string, Promise<BaileysManager>>();
  private readonly failures = new Map<string, { attempts: number; failedAt: number }>();
  private readonly lockUnsupportedReason: string | null;
  private lockUnsupportedLogged = false;
  private lastNeeded = "";

  constructor(databaseUrl: string = databaseUrls.session) {
    this.lockUnsupportedReason = sessionLockUnsupportedReason(databaseUrl);
  }

  /** The running manager, dropping one that stopped itself (e.g. lost its session lock) so it gets restarted. */
  private runningManager(numberId: string): BaileysManager | undefined {
    const manager = this.managers.get(numberId);
    if (manager?.isStopped) {
      this.managers.delete(numberId);
      return undefined;
    }
    return manager;
  }

  /**
   * Lazily starts (once) and returns the manager for a number. Safe to call
   * repeatedly/concurrently for the same number: callers share one in-flight
   * start. A failed start, or a call while that number is backing off, throws
   * ProviderDeferredError so sends are retried later instead of failing.
   */
  async getOrCreateManager(workspaceId: string, numberId: string): Promise<BaileysManager> {
    const existing = this.runningManager(numberId);
    if (existing) return existing;

    if (this.lockUnsupportedReason) throw new ProviderDeferredError(this.lockUnsupportedReason, START_BACKOFF_MAX_MS);

    const inFlight = this.starting.get(numberId);
    if (inFlight) return inFlight;

    const remaining = this.backoffRemainingMs(numberId);
    if (remaining > 0) throw new ProviderDeferredError(RECOVERING_MESSAGE, remaining);

    const startPromise = (async () => {
      const manager = new BaileysManager(workspaceId, numberId);
      try {
        await manager.start();
      } catch (error) {
        const attempts = (this.failures.get(numberId)?.attempts ?? 0) + 1;
        this.failures.set(numberId, { attempts, failedAt: Date.now() });
        const retryMs = startBackoffMs(attempts);
        console.error(
          `[baileys-registry] WhatsApp start failed for number ${numberId} of workspace ${workspaceId} (attempt ${attempts}, retrying in ${retryMs / 1000}s):`,
          error,
        );
        throw new ProviderDeferredError(RECOVERING_MESSAGE, retryMs);
      } finally {
        this.starting.delete(numberId);
      }
      this.failures.delete(numberId);
      this.managers.set(numberId, manager);
      return manager;
    })();
    this.starting.set(numberId, startPromise);
    return startPromise;
  }

  getExistingManager(numberId: string): BaileysManager | undefined {
    return this.runningManager(numberId);
  }

  private backoffRemainingMs(numberId: string): number {
    const failure = this.failures.get(numberId);
    if (!failure) return 0;
    return Math.max(failure.failedAt + startBackoffMs(failure.attempts) - Date.now(), 0);
  }

  /**
   * Called on every worker tick. Starts a manager only for numbers that need a
   * socket (see NEEDS_MANAGER_SQL), ONE AT A TIME, so many numbers never open
   * many session-lock connections at once; and stops managers that are no
   * longer needed, closing their lock connections. Pairing from Settings is
   * picked up on the next tick. A failed start is retried once its backoff
   * (B17) has elapsed. Logs the numbers per workspace whenever the set changes.
   */
  async ensureManagers(): Promise<void> {
    if (this.lockUnsupportedReason) {
      if (!this.lockUnsupportedLogged) console.error(`[baileys-registry] ${this.lockUnsupportedReason}`);
      this.lockUnsupportedLogged = true;
      return;
    }
    const result = await pool.query<NeededNumber>(NEEDS_MANAGER_SQL);
    const needed = new Map(result.rows.map((row) => [row.id, row.workspace_id]));
    const signature = result.rows.map((row) => row.id).join(",");
    if (signature !== this.lastNeeded) console.log(`[baileys-registry] ${describeNeededNumbers(result.rows)}`);
    this.lastNeeded = signature;

    for (const [numberId, manager] of this.managers) {
      if (needed.has(numberId)) continue;
      this.managers.delete(numberId);
      await manager.stop().catch(() => undefined);
    }

    for (const [numberId, workspaceId] of needed) {
      if (this.runningManager(numberId) || this.starting.has(numberId) || this.backoffRemainingMs(numberId) > 0) continue;
      // Start failures are already logged and recorded by getOrCreateManager.
      await this.getOrCreateManager(workspaceId, numberId).catch(() => undefined);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.managers.values()].map((manager) => manager.stop().catch(() => undefined)));
    this.managers.clear();
    this.starting.clear();
    this.failures.clear();
  }
}

export const baileysRegistry = new BaileysManagerRegistry();
