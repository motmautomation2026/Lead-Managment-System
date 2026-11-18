import express from "express";
import cors from "cors";
import helmet from "helmet";
import { corsOrigins } from "./env.js";
import { apiRouter } from "./routes/index.js";
import { createTrackingRouter } from "./routes/tracking.routes.js";
import { workerHealth } from "./services/systemHealth.service.js";
import { errorMiddleware, notFoundMiddleware, requestIdMiddleware } from "./errorMiddleware.js";

export function createApp() {
  const app = express();

  app.use(requestIdMiddleware);
  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  // E3b-2b: the public email open pixel; outside /api/v1, so no auth or X-Workspace-Id.
  app.use(createTrackingRouter());
  // P7: for an external uptime monitor; no auth, no workspace data (only ok/stale and loop names).
  app.get("/health/worker", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const health = await workerHealth();
      res.status(health.status === "ok" ? 200 : 503).json(health);
    } catch {
      res.status(503).json({ status: "stale", stale: [] });
    }
  });

  app.use("/api/v1", apiRouter);

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
