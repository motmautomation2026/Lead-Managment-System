import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { requireAdmin } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import { InvalidTransitionError } from "../errors.js";
import { parseBody, parseParams, parseQuery, queryBoolean, uuidParam } from "../validation/parse.js";
import { AGENT_ACTIONS } from "../agent/decisionSchema.js";
import { RATING_REASONS } from "../agent/readiness.js";
import { LIVE_MODE_UNAVAILABLE, settingsUpdateSchema } from "../agent/settingsSchema.js";
import * as review from "../services/agentReview.service.js";
import * as settings from "../services/agentSettings.service.js";
import * as agentStatus from "../services/agentStatus.service.js";
import { leadToDto, type LeadRow } from "../services/leads.service.js";
import { getLeadNextAction } from "../services/tasks.service.js";

/**
 * AI agent review (any CRM user unless noted), then configuration and lead
 * enrollment (admin only). Mounted inside crmRouter, so requireAuth +
 * requireCrmUser + requireWorkspace have already run. Nothing here calls
 * OpenAI or sends anything.
 */
export const agentRouter = Router();
agentRouter.param("id", uuidParam("lead"));
agentRouter.param("decisionId", uuidParam("decision"));
agentRouter.param("reportId", uuidParam("report"));

const ws = (req: { workspaceId?: string }) => req.workspaceId!;
const withNextAction = async (row: LeadRow) => leadToDto(row, await getLeadNextAction(pool, row.id));

// --- Review (3D-1): CRM users ---------------------------------------------------

const decisionsQuery = z
  .object({
    action: z.enum(AGENT_ACTIONS).optional(),
    outcome: z.enum(review.DECISION_OUTCOMES).optional(),
    leadId: z.string().uuid().optional(),
    rating: z.enum(review.RATING_FILTERS).optional(),
    hasOpenReport: queryBoolean.optional(),
    from: z.string().datetime({ offset: true }).or(z.string().date()).pipe(z.coerce.date()).optional(),
    to: z.string().datetime({ offset: true }).or(z.string().date()).pipe(z.coerce.date()).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
agentRouter.get(
  "/decisions",
  asyncHandler(async (req, res) => res.json(await review.listDecisions(pool, ws(req), parseQuery(decisionsQuery, req.query)))),
);
agentRouter.get("/decisions/:decisionId", asyncHandler(async (req, res) => res.json(await review.getDecision(pool, ws(req), req.params.decisionId!))));

const noteSchema = z.string().trim().max(2000);
const ratingSchema = z
  .object({ rating: z.enum(["good", "bad"]), reason: z.enum(RATING_REASONS).optional(), note: noteSchema.optional() })
  .strict()
  .refine((v) => (v.rating === "bad") === Boolean(v.reason), { message: "A bad rating needs a reason; a good rating takes none.", path: ["reason"] });
agentRouter.put(
  "/decisions/:decisionId/rating",
  asyncHandler(async (req, res) => res.json(await review.rateDecision(pool, ws(req), req.params.decisionId!, req.actor!, parseBody(ratingSchema, req.body)))),
);

const reportSchema = z.object({ note: noteSchema.min(1, "Describe the problem.") }).strict();
agentRouter.post(
  "/decisions/:decisionId/reports",
  asyncHandler(async (req, res) => {
    const { note } = parseBody(reportSchema, req.body);
    res.status(201).json(await withTransaction((c) => review.reportProblem(c, ws(req), req.params.decisionId!, req.actor!, note)));
  }),
);
const resolveSchema = z.object({ note: noteSchema.optional() }).strict();
agentRouter.post(
  "/reports/:reportId/resolve",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { note } = parseBody(resolveSchema, req.body ?? {});
    res.json(await review.resolveReport(pool, ws(req), req.params.reportId!, req.actor!, note));
  }),
);

agentRouter.get("/stats", asyncHandler(async (req, res) => res.json(await review.getAgentStats(pool, ws(req)))));
agentRouter.get("/leads/:id", asyncHandler(async (req, res) => res.json(await review.getLeadAgentPanel(pool, ws(req), req.params.id!))));

// --- Configuration and enrollment: admin only. Every route below this line. ----------
agentRouter.use(requireAdmin);

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
