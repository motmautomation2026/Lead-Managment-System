import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { requireAdmin } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import { InvalidTransitionError } from "../errors.js";
import { parseBody, parseParams, uuidParam } from "../validation/parse.js";
import { LIVE_MODE_UNAVAILABLE, settingsUpdateSchema } from "../agent/settingsSchema.js";
import * as settings from "../services/agentSettings.service.js";
import * as agentStatus from "../services/agentStatus.service.js";
import { leadToDto, type LeadRow } from "../services/leads.service.js";
import { getLeadNextAction } from "../services/tasks.service.js";

/**
 * AI agent configuration and lead enrollment. Admin only (mounted inside
 * crmRouter, so requireAuth + requireCrmUser + requireWorkspace have already
 * run). Nothing here calls OpenAI or sends anything.
 */
export const agentRouter = Router();
agentRouter.use(requireAdmin);
agentRouter.param("id", uuidParam("lead"));

const ws = (req: { workspaceId?: string }) => req.workspaceId!;
const withNextAction = async (row: LeadRow) => leadToDto(row, await getLeadNextAction(pool, row.id));

agentRouter.get("/settings", asyncHandler(async (req, res) => res.json(await settings.getSettings(pool, ws(req)))));

agentRouter.put(
  "/settings",
  asyncHandler(async (req, res) => {
    // A valid value that isn't available yet: 422, not a 400.
    if ((req.body as { mode?: unknown } | undefined)?.mode === "live") throw new InvalidTransitionError(LIVE_MODE_UNAVAILABLE);
    res.json(await settings.updateSettings(req.actor!, ws(req), parseBody(settingsUpdateSchema, req.body)));
  }),
);

agentRouter.get("/playbooks", asyncHandler(async (req, res) => res.json(await settings.listPlaybooks(pool, ws(req)))));

const playbookSchema = z.object({ body: z.string().trim().min(1, "The playbook can't be empty.").max(50_000) });
agentRouter.post(
  "/playbooks",
  asyncHandler(async (req, res) => res.status(201).json(await settings.createPlaybookVersion(req.actor!, ws(req), parseBody(playbookSchema, req.body).body))),
);

const versionParams = z.object({ version: z.coerce.number().int().positive() });
agentRouter.post(
  "/playbooks/:version/restore",
  asyncHandler(async (req, res) => {
    const { version } = parseParams(versionParams, req.params);
    res.status(201).json(await settings.restorePlaybookVersion(req.actor!, ws(req), version));
  }),
);

const enrollSchema = z.object({ leadIds: z.array(z.string().uuid()).min(1).max(agentStatus.MAX_ENROLL_BATCH) });
agentRouter.post(
  "/leads/enroll",
  asyncHandler(async (req, res) => {
    const { leadIds } = parseBody(enrollSchema, req.body);
    res.json({ data: await agentStatus.enrollLeads(pool, req.actor!, ws(req), leadIds) });
  }),
);

agentRouter.post(
  "/leads/:id/pause",
  asyncHandler(async (req, res) => res.json(await withNextAction(await withTransaction((c) => agentStatus.pauseLead(c, req.actor!, ws(req), req.params.id!))))),
);
agentRouter.post(
  "/leads/:id/resume",
  asyncHandler(async (req, res) => res.json(await withNextAction(await withTransaction((c) => agentStatus.resumeLead(c, req.actor!, ws(req), req.params.id!))))),
);

const stopSchema = z.object({ note: z.string().max(2000).optional() });
agentRouter.post(
  "/leads/:id/stop",
  asyncHandler(async (req, res) => {
    const { note } = parseBody(stopSchema, req.body ?? {});
    res.json(await withNextAction(await withTransaction((c) => agentStatus.stopLead(c, req.actor!, ws(req), req.params.id!, note))));
  }),
);

agentRouter.post(
  "/leads/:id/wake",
  asyncHandler(async (req, res) => res.json(await withTransaction((c) => agentStatus.wakeNow(c, ws(req), req.params.id!)))),
);
