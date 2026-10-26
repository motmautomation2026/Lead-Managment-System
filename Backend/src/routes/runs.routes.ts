import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { requireAuth } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import { parseBody, parseQuery, uuidParam } from "../validation/parse.js";
import { SCHEDULED_ACTION_STATUSES, WORKFLOW_RUN_STATUSES } from "../domain/enums.js";
import { ValidationError } from "../errors.js";
import * as runsService from "../services/runs.service.js";
import { autoEnroll, enrollLeadInWorkflow } from "../services/runs.service.js";
import * as lists from "../services/automationLists.service.js";

export const runsRouter = Router();
runsRouter.use(requireAuth);
runsRouter.param("id", uuidParam("run"));

const listQuerySchema = z.object({
  workflowId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  status: z.enum(WORKFLOW_RUN_STATUSES).optional(),
});

/** Deprecated (unpaginated): kept for the production rollback; the UI uses GET /runs/list since C6b. */
runsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const filters = parseQuery(listQuerySchema, req.query);
    res.json({ data: await runsService.listRuns(pool, req.workspaceId!, filters) });
  }),
);

/** C6b list standard (docs/crm-v2/B4-api.md §7b). */
runsRouter.get(
  "/list",
  asyncHandler(async (req, res) => {
    res.json(await lists.listRunsPage(pool, req.workspaceId!, parseQuery(lists.runListSchema, req.query)));
  }),
);

runsRouter.get(
  "/count",
  asyncHandler(async (req, res) => {
    res.json(await lists.countRuns(pool, req.workspaceId!, parseQuery(lists.runFilterSchema, req.query)));
  }),
);

const enrollSchema = z.object({ leadId: z.string().uuid(), workflowId: z.string().uuid().optional(), reason: z.string().optional() });

/**
 * Manual enrollment. With `workflowId`, enrolls the lead in exactly that
 * workflow (any trigger — a salesperson's explicit choice). Without it,
 * falls back to the product brief's 'manual_enrollment' trigger lookup for
 * backward compatibility.
 */
runsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { leadId, workflowId, reason } = parseBody(enrollSchema, req.body);
    const enrolledReason = reason ?? "Manually enrolled";

    if (workflowId) {
      const run = await withTransaction((client) => enrollLeadInWorkflow(client, req.workspaceId!, leadId, workflowId, enrolledReason));
      if (!run) {
        throw new ValidationError("This lead already has an active run for that workflow.");
      }
      res.status(201).json({ data: [run] });
      return;
    }

    const created = await withTransaction((client) => autoEnroll(client, req.workspaceId!, leadId, "manual_enrollment", enrolledReason));
    if (created.length === 0) {
      throw new ValidationError("No active published workflow with trigger 'manual_enrollment' is available to enroll this lead in.");
    }
    res.status(201).json({ data: created });
  }),
);

const reasonSchema = z.object({ reason: z.string().optional() });

runsRouter.post(
  "/:id/pause",
  asyncHandler(async (req, res) => {
    const { reason } = parseBody(reasonSchema, req.body ?? {});
    res.json(await withTransaction((client) => runsService.pauseRun(client, req.actor!, req.workspaceId!, req.params.id!, reason)));
  }),
);

runsRouter.post(
  "/:id/resume",
  asyncHandler(async (req, res) => {
    res.json(await withTransaction((client) => runsService.resumeRun(client, req.actor!, req.workspaceId!, req.params.id!)));
  }),
);

runsRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    const { reason } = parseBody(reasonSchema, req.body ?? {});
    res.json(await withTransaction((client) => runsService.cancelRun(client, req.actor!, req.workspaceId!, req.params.id!, reason)));
  }),
);

runsRouter.post(
  "/:id/retry",
  asyncHandler(async (req, res) => {
    res.json(await withTransaction((client) => runsService.retryRun(client, req.actor!, req.workspaceId!, req.params.id!)));
  }),
);

// --- Scheduled actions (read only; the worker executes them) -------------------

export const scheduledActionsRouter = Router();
scheduledActionsRouter.use(requireAuth);

const scheduledQuerySchema = z.object({
  leadId: z.string().uuid().optional(),
  workflowRunId: z.string().uuid().optional(),
  status: z.enum(SCHEDULED_ACTION_STATUSES).optional(),
});

/** Deprecated (unpaginated): kept for the production rollback; the UI uses GET /scheduled-actions/list since C6b. */
scheduledActionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const filters = parseQuery(scheduledQuerySchema, req.query);
    res.json({ data: await runsService.listScheduledActions(pool, req.workspaceId!, filters) });
  }),
);

scheduledActionsRouter.get(
  "/list",
  asyncHandler(async (req, res) => {
    res.json(await lists.listScheduledActionsPage(pool, req.workspaceId!, parseQuery(lists.scheduledActionListSchema, req.query)));
  }),
);

scheduledActionsRouter.get(
  "/count",
  asyncHandler(async (req, res) => {
    res.json(await lists.countScheduledActions(pool, req.workspaceId!, parseQuery(lists.scheduledActionFilterSchema, req.query)));
  }),
);
