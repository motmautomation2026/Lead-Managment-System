/**
 * P7: test cleanup against the remote staging database and Storage retries transient network
 * errors (3 attempts, backoff). Anything else (a constraint, a bug) is thrown at once.
 */
const NETWORK_RE = /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|timed? ?out|timeout|Connection terminated/i;

/** True for a transient network error, also when it is the `cause` of a wrapper error (undici's "fetch failed"). */
export function isNetworkError(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const { message, code } = e as { message?: unknown; code?: unknown };
    if (NETWORK_RE.test(`${typeof code === "string" ? code : ""} ${typeof message === "string" ? message : ""}`)) return true;
  }
  return false;
}

export async function withNetworkRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseMs = 1_000, wait = (ms: number) => new Promise((r) => setTimeout(r, ms)) }: { attempts?: number; baseMs?: number; wait?: (ms: number) => Promise<unknown> } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isNetworkError(error)) throw error;
      console.warn(`[test cleanup] network error (${error instanceof Error ? error.message : String(error)}), retry ${attempt}/${attempts - 1}`);
      await wait(baseMs * 2 ** (attempt - 1));
    }
  }
}
