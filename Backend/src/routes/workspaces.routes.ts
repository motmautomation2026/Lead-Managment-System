import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { requireAuth, requireCrmUser, requireSuperAdmin } from "../authMiddleware.js";
import { parseBody, parseParams, uuidParam } from "../validation/parse.js";
import * as workspacesService from "../services/workspaces.service.js";

/**
 * Deliberately NOT gated by requireWorkspace: a workspace must be listable
 * (and creatable) before the frontend has one selected to send as
 * X-Workspace-Id. E4b: the list holds only the user's workspaces (super-admin: all); any CRM user
 * may create one and becomes its admin (rule 11); renaming is super-admin only.
 */
export const workspacesRouter = Router();
workspacesRouter.use(requireAuth, requireCrmUser);
workspacesRouter.param("id", uuidParam("workspace"));

workspacesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ data: await workspacesService.listWorkspaces(req.actor!) });
  }),
);

const createWorkspaceSchema = z.object({ name: z.string().min(1) });

workspacesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parseBody(createWorkspaceSchema, req.body);
    const workspace = await workspacesService.createWorkspace(req.actor!, input);
    res.status(201).json(workspace);
  }),
);

const workspaceIdParamsSchema = z.object({ id: z.string().uuid() });
const renameWorkspaceSchema = z.object({ name: z.string().min(1) });

workspacesRouter.patch(
  "/:id",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseParams(workspaceIdParamsSchema, req.params);
    const input = parseBody(renameWorkspaceSchema, req.body);
    res.json(await workspacesService.renameWorkspace(req.actor!, id, input));
  }),
);
