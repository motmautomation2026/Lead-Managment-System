import { pool, sessionLockUnsupportedReason } from "../db.js";
import { env } from "../env.js";
import { BaileysManager } from "./baileys.manager.js";
import { ProviderDeferredError } from "./provider-errors.js";

const START_BACKOFF_BASE_MS = 30_000;
const START_BACKOFF_MAX_MS = 10 * 60_000;
const RECOVERING_MESSAGE = "WhatsApp is starting up or recovering for this workspace.";

/** Wait before retrying a workspace whose manager failed to start `attempts` times in a row: 30s × 2^(n-1), capped at 10 min. */
export function startBackoffMs(attempts: number): number {
  return Math.min(START_BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), START_BACKOFF_MAX_MS);
}

/**
 * One BaileysManager per workspace (each workspace pairs and owns its own
 * WhatsApp number — see the multi-workspace architecture plan). The worker
 * process is still a single Node process/poll loop; this registry is what
 * lets that one process hold N independent Baileys sockets, one per active
 * workspace, each with its own Postgres advisory lock so a second worker
 * process can never double-own the same workspace's session.
 */
export class BaileysManagerRegistry {
  private readonly managers = new Map<string, BaileysManager>();
  private readonly starting = new Map<string, Promise<BaileysManager>>();
  private readonly failures = new Map<string, { attempts: number; failedAt: number }>();
  private readonly lockUnsupportedReason: string | null;
  private lockUnsupportedLogged = false;

  constructor(databaseUrl: string = env.DATABASE_URL) {
    this.lockUnsupportedReason = sessionLockUnsupportedReason(databaseUrl);
  }

  /** The running manager, dropping one that stopped itself (e.g. lost its session lock) so it gets restarted. */
  private runningManager(workspaceId: string): BaileysManager | undefined {
    const manager = this.managers.get(workspaceId);
    if (manager?.isStopped) {
      this.managers.delete(workspaceId);
      return undefined;
    }
    return manager;
  }

  /**
   * Lazily starts (once) and returns the manager for a workspace. Safe to call
   * repeatedly/concurrently for the same workspace: callers share one in-flight
   * start. A failed start, or a call while that workspace is backing off, throws
   * ProviderDeferredError so sends are retried later instead of failing.
   */
  async getOrCreateManager(workspaceId: string): Promise<BaileysManager> {
    const existing = this.runningManager(workspaceId);
    if (existing) return existing;

    if (this.lockUnsupportedReason) throw new ProviderDeferredError(this.lockUnsupportedReason, START_BACKOFF_MAX_MS);

    const inFlight = this.starting.get(workspaceId);
    if (inFlight) return inFlight;

    const remaining = this.backoffRemainingMs(workspaceId);
    if (remaining > 0) throw new ProviderDeferredError(RECOVERING_MESSAGE, remaining);

    const startPromise = (async () => {
      const manager = new BaileysManager(workspaceId);
      try {
        await manager.start();
      } catch (error) {
        const attempts = (this.failures.get(workspaceId)?.attempts ?? 0) + 1;
        this.failures.set(workspaceId, { attempts, failedAt: Date.now() });
        const retryMs = startBackoffMs(attempts);
        console.error(
          `[baileys-registry] WhatsApp start failed for workspace ${workspaceId} (attempt ${attempts}, retrying in ${retryMs / 1000}s):`,
          error,
        );
        throw new ProviderDeferredError(RECOVERING_MESSAGE, retryMs);
      } finally {
        this.starting.delete(workspaceId);
      }
      this.failures.delete(workspaceId);
      this.managers.set(workspaceId, manager);
      return manager;
    })();
    this.starting.set(workspaceId, startPromise);
    return startPromise;
  }

  getExistingManager(workspaceId: string): BaileysManager | undefined {
    return this.runningManager(workspaceId);
  }

  private backoffRemainingMs(workspaceId: string): number {
    const failure = this.failures.get(workspaceId);
    if (!failure) return 0;
    return Math.max(failure.failedAt + startBackoffMs(failure.attempts) - Date.now(), 0);
  }

  /**
   * Called periodically by the worker so every active workspace has a
   * running manager — a manager's own heartbeat loop (started in start())
   * is what actually reacts to an admin's connect/restart/logout command
   * (see BaileysManager.syncControl), so a workspace that has never had a
   * manager started for it would otherwise never notice a connect request.
   * A workspace whose start failed (e.g. another process still holding its
   * advisory lock) is retried here once its backoff has elapsed.
   */
  async ensureManagersForAllActiveWorkspaces(): Promise<void> {
    if (this.lockUnsupportedReason) {
      if (!this.lockUnsupportedLogged) console.error(`[baileys-registry] ${this.lockUnsupportedReason}`);
      this.lockUnsupportedLogged = true;
      return;
    }
    const result = await pool.query<{ id: string }>(`select id from public.workspaces where is_active = true`);
    await Promise.all(
      result.rows.map(async (row) => {
        if (this.runningManager(row.id) || this.starting.has(row.id) || this.backoffRemainingMs(row.id) > 0) return;
        // Start failures are already logged and recorded by getOrCreateManager.
        await this.getOrCreateManager(row.id).catch(() => undefined);
      }),
    );
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.managers.values()].map((manager) => manager.stop().catch(() => undefined)));
    this.managers.clear();
    this.starting.clear();
    this.failures.clear();
  }
}

export const baileysRegistry = new BaileysManagerRegistry();
