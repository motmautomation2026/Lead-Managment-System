import { Router } from "express";
import { pool } from "../db.js";
import { createRateLimiter, OPEN_TOKEN_RE, TRANSPARENT_GIF } from "../domain/emailTracking.js";
import { recordEmailOpen } from "../services/emailOpens.service.js";

/**
 * E3b-2b rule 11: the public open pixel, GET /t/o/<token>.gif. Mounted before auth and the
 * X-Workspace-Id middleware. Every request gets the same 1×1 GIF (200), also for unknown or
 * malformed tokens and over the rate limit, so tokens can't be probed. The token's format is
 * checked before the database is touched; then one small UPDATE. No IP or user agent is stored.
 */
export function createTrackingRouter(record: (token: string) => Promise<void> = (token) => recordEmailOpen(pool, token)) {
  const allowed = createRateLimiter(60, 60_000);
  const router = Router();
  router.get("/t/o/:file", async (req, res) => {
    const token = /^(.*)\.gif$/.exec(req.params.file ?? "")?.[1];
    // The IP is only a key in memory for the per-minute limit.
    if (token && OPEN_TOKEN_RE.test(token) && allowed(req.ip ?? "")) {
      await record(token).catch((error: { code?: string; name?: string }) => console.error(`[open-pixel] not recorded: ${error?.code ?? error?.name ?? "error"}`));
    }
    res
      .status(200)
      .set({ "Content-Type": "image/gif", "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "cross-origin" })
      .send(TRANSPARENT_GIF);
  });
  return router;
}
