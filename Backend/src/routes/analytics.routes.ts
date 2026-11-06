import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { pool } from "../db.js";
import { parseQuery } from "../validation/parse.js";
import { funnelQuerySchema, getFunnel } from "../services/funnel.service.js";

/** E3b-2b rule 19: funnel numbers (any CRM user, the selected workspace). */
export const analyticsRouter = Router();

analyticsRouter.get(
  "/funnel",
  asyncHandler(async (req, res) => res.json(await getFunnel(pool, req.workspaceId!, parseQuery(funnelQuerySchema, req.query)))),
);
