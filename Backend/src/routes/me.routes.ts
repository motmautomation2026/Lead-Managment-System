import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { requireAuth } from "../authMiddleware.js";
import { pool } from "../db.js";
import { listWorkspaces } from "../services/workspaces.service.js";
import { bookingUrlSchema, getBookingUrl, listProfiles, setBookingUrl } from "../services/profiles.service.js";
import { parseBody } from "../validation/parse.js";

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({
      id: req.actor!.id,
      name: req.actor!.fullName,
      email: req.actor!.email,
      // The global role: only /admin user management uses it (E4b). Workspace roles are in `workspaces`.
      role: req.actor!.role,
      isSuperAdmin: req.actor!.isSuperAdmin === true,
      // E4b rule 4: the workspaces this user may open, with their role in each.
      workspaces: await listWorkspaces(req.actor!),
      // E3b-1 rule 5: the AI adds it to messages that ask this user's contacts for a call.
      bookingUrl: await getBookingUrl(pool, req.actor!.id),
    });
  }),
);

// E3b-1 rule 5: each user edits their own booking link (Settings → Profile).
const updateMeSchema = z.object({ bookingUrl: bookingUrlSchema }).strict();
meRouter.patch(
  "/",
  asyncHandler(async (req, res) => {
    const { bookingUrl } = parseBody(updateMeSchema, req.body);
    await setBookingUrl(pool, req.actor!.id, bookingUrl);
    res.json({ bookingUrl });
  }),
);

/** Mounted inside the CRM router: the directory of the X-Workspace-Id workspace (E4b rule 5). */
export const profilesRouter = Router();

profilesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ data: await listProfiles(pool, req.workspaceId!) });
  }),
);
