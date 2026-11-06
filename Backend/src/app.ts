import express from "express";
import cors from "cors";
import helmet from "helmet";
import { corsOrigins } from "./env.js";
import { apiRouter } from "./routes/index.js";
import { createTrackingRouter } from "./routes/tracking.routes.js";
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

  app.use("/api/v1", apiRouter);

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
