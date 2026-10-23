import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { requireAdmin } from "../authMiddleware.js";
import { parseBody } from "../validation/parse.js";
import { MAX_ASSIGNMENT_RULES } from "../domain/revenue.js";
import * as assignment from "../services/leadAssignment.service.js";

/**
 * Revenue-based owner assignment rules for new leads, per workspace. Admin
 * only (mounted inside crmRouter, so requireAuth + requireCrmUser +
 * requireWorkspace have already run).
 */
export const assignmentRulesRouter = Router();
assignmentRulesRouter.use(requireAdmin);

assignmentRulesRouter.get("/", asyncHandler(async (req, res) => res.json(await assignment.getAssignmentRules(req.workspaceId!))));

const crore = z.number().nonnegative().max(1_000_000_000).nullable();
const replaceSchema = z.object({
  rules: z
    .array(z.object({ position: z.number().int().min(0), minCr: crore, maxCr: crore, ownerId: z.string().uuid() }))
    .max(MAX_ASSIGNMENT_RULES),
  fallbackOwnerId: z.string().uuid().nullable(),
});

assignmentRulesRouter.put(
  "/",
  asyncHandler(async (req, res) => res.json(await assignment.replaceAssignmentRules(req.actor!, req.workspaceId!, parseBody(replaceSchema, req.body)))),
);
