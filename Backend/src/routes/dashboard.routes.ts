import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { requireAuth } from "../authMiddleware.js";
import { pool } from "../db.js";
import { getDashboardSummary, listTodaysQueue } from "../services/dashboard.service.js";
import { getHomeSummary } from "../services/home.service.js";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/** Deprecated (the old dashboard): kept for the production rollback; the UI uses GET /home/summary since C6b. */
dashboardRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const [summary, queue] = await Promise.all([
      getDashboardSummary(pool, req.workspaceId!),
      listTodaysQueue(pool, req.workspaceId!),
    ]);
    res.json({ ...summary, todaysQueue: queue });
  }),
);

/** C6b Home page: the signed-in user's day, pipeline, proposals and AI drafts. */
export const homeRouter = Router();
homeRouter.use(requireAuth);

homeRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    res.json(await getHomeSummary(pool, req.actor!, req.workspaceId!));
  }),
);
