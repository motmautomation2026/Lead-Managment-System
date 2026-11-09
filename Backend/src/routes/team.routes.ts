import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { requireAdmin, requireAuth, requireCrmUser, requireSuperAdmin } from "../authMiddleware.js";
import { parseBody, parseParams, parseQuery } from "../validation/parse.js";
import * as team from "../services/team.service.js";

/** E4b rule 9: Settings → Team, the X-Workspace-Id workspace's members (its admins, or a super-admin). Mounted in the CRM router. */
export const teamRouter = Router();
teamRouter.use(requireAdmin);

const userParams = z.object({ userId: z.string().uuid() });

teamRouter.get("/members", asyncHandler(async (req, res) => res.json({ data: await team.listMembers(req.workspaceId!) })));
teamRouter.post(
  "/members",
  asyncHandler(async (req, res) => res.status(201).json({ data: await team.addMember(req.actor!, req.workspaceId!, parseBody(team.addMemberSchema, req.body)) })),
);
teamRouter.patch(
  "/members/:userId",
  asyncHandler(async (req, res) => {
    const { userId } = parseParams(userParams, req.params);
    res.json({ data: await team.changeMemberRole(req.actor!, req.workspaceId!, userId, parseBody(team.changeRoleSchema, req.body).role) });
  }),
);
teamRouter.delete(
  "/members/:userId",
  asyncHandler(async (req, res) => {
    const { userId } = parseParams(userParams, req.params);
    res.json({ data: await team.removeMember(req.actor!, req.workspaceId!, userId) });
  }),
);

/** E4b rule 10: every workspace × user (super-admin only, no workspace header). New workspaces: POST /workspaces. */
export const superAdminRouter = Router();
superAdminRouter.use(requireAuth, requireCrmUser, requireSuperAdmin);

superAdminRouter.get("/memberships", asyncHandler(async (req, res) => res.json(await team.listMemberships(parseQuery(team.membershipListSchema, req.query)))));
superAdminRouter.put(
  "/memberships",
  asyncHandler(async (req, res) => res.json({ data: await team.setMembership(req.actor!, parseBody(team.setMembershipSchema, req.body)) })),
);
