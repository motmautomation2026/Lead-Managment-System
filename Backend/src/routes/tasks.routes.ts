import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { assertAssignableUser } from "../services/profiles.service.js";
import { requireAuth } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import { parseBody, parseQuery, queryBoolean, uuidParam } from "../validation/parse.js";
import { TASK_STATUSES, TASK_TYPES } from "../domain/enums.js";
import { cancelTask, completeTask, createTask, listTasks, taskToDto, updateTask } from "../services/tasks.service.js";
import * as work from "../services/workLists.service.js";

export const tasksRouter = Router();
tasksRouter.use(requireAuth);
tasksRouter.param("id", uuidParam("task"));

const listQuerySchema = z.object({
  ownerId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  type: z.enum(TASK_TYPES).optional(),
  overdueOnly: queryBoolean.optional(),
  dueTodayOnly: queryBoolean.optional(),
});

tasksRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const filters = parseQuery(listQuerySchema, req.query);
    res.json({ data: await listTasks(pool, req.workspaceId!, filters) });
  }),
);

/** C6a list standard (docs/crm-v2/B4-api.md §7a). The old GET / above is deprecated: kept for the production rollback. */
tasksRouter.get(
  "/list",
  asyncHandler(async (req, res) => {
    res.json(await work.listWorkTasks(pool, req.actor!, req.workspaceId!, parseQuery(work.taskListSchema, req.query)));
  }),
);

tasksRouter.get(
  "/count",
  asyncHandler(async (req, res) => {
    res.json(await work.countWorkTasks(pool, req.actor!, req.workspaceId!, parseQuery(work.taskFilterSchema, req.query)));
  }),
);

const createSchema = z.object({
  leadId: z.string().uuid(),
  ownerId: z.string().uuid().optional(),
  type: z.enum(TASK_TYPES),
  title: z.string().min(1),
  dueAt: z.string().datetime({ offset: true }),
});

tasksRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parseBody(createSchema, req.body);
    // E4b rule 5: a rep's chosen assignee must be a member (automatic tasks keep going to the lead's owner).
    if (input.ownerId) await assertAssignableUser(pool, req.workspaceId!, input.ownerId);
    const task = await withTransaction((client) => createTask(client, req.actor!, req.workspaceId!, { ...input, origin: "manual" }));
    res.status(201).json(taskToDto(task));
  }),
);

const updateSchema = z.object({
  ownerId: z.string().uuid().optional(),
  type: z.enum(TASK_TYPES).optional(),
  title: z.string().min(1).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
});

tasksRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const patch = parseBody(updateSchema, req.body);
    res.json(await withTransaction((client) => updateTask(client, req.actor!, req.workspaceId!, req.params.id!, patch)));
  }),
);

tasksRouter.post(
  "/:id/complete",
  asyncHandler(async (req, res) => {
    const task = await withTransaction((client) => completeTask(client, req.actor!, req.workspaceId!, req.params.id!));
    res.json(taskToDto(task));
  }),
);

const cancelSchema = z.object({ reason: z.string().optional() });

tasksRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    const { reason } = parseBody(cancelSchema, req.body ?? {});
    const task = await withTransaction((client) => cancelTask(client, req.actor!, req.workspaceId!, req.params.id!, reason));
    res.json(taskToDto(task));
  }),
);
