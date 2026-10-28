import { DisconnectReason } from "baileys";

/**
 * What to do when the socket closes without us asking (B4, https://baileys.wiki):
 * - `logged_out` 401: never reconnect; clear auth, needs a new QR; pause + notify.
 * - `pause` 403 forbidden (likely a ban) / 440 connectionReplaced (another session took over):
 *   never reconnect (don't fight it), keep auth; pause + notify.
 * - `repair` 411 multideviceMismatch / 500 badSession: stop, clear auth, notify (needs re-pair).
 * - `reconnect_now` 515 restartRequired (normal right after pairing).
 * - `reconnect` anything else (428, 408, 503, …): exponential backoff + jitter.
 */
export type DisconnectAction = "logged_out" | "pause" | "repair" | "reconnect_now" | "reconnect";

export function disconnectAction(code: number | undefined): DisconnectAction {
  switch (code) {
    case DisconnectReason.loggedOut:
      return "logged_out";
    case DisconnectReason.forbidden:
    case DisconnectReason.connectionReplaced:
      return "pause";
    case DisconnectReason.multideviceMismatch:
    case DisconnectReason.badSession:
      return "repair";
    case DisconnectReason.restartRequired:
      return "reconnect_now";
    default:
      return "reconnect";
  }
}

/** 5 s × 2^attempt, capped at 10 min, ±25 % jitter. */
export function reconnectDelayMs(attempt: number, random = Math.random()) {
  const base = Math.min(5_000 * 2 ** Math.max(0, attempt), 600_000);
  return Math.round(base * (0.75 + random * 0.5));
}

export function randomSpacingMs(minSeconds: number, maxSeconds: number, random = Math.random()) {
  return Math.round((minSeconds + random * (maxSeconds - minSeconds)) * 1_000);
}

export function isOutboundRestricted(
  reachout: { isActive?: boolean } | null,
  cap: { capping_status?: string; ote_status?: string } | null,
) {
  return Boolean(reachout?.isActive || cap?.capping_status === "CAPPED" || cap?.ote_status === "EXHAUSTED");
}
