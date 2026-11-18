import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { requireAuth } from "../authMiddleware.js";
import { pool } from "../db.js";
import { listWorkspaces } from "../services/workspaces.service.js";
import { alertPrefsSchema, bookingUrlSchema, getAlertPrefs, getBookingUrl, listProfiles, setAlertPrefs, setBookingUrl } from "../services/profiles.service.js";
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
      // LL-2 rule 3: staff email alerts + morning digest (Settings → Profile).
      ...(await getAlertPrefs(pool, req.actor!.id)),
    });
  }),
);

// E3b-1 rule 5: each user edits their own booking link; LL-2: and their email alert toggles (Settings → Profile).
const updateMeSchema = z
  .object({ bookingUrl: bookingUrlSchema.optional(), ...alertPrefsSchema })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update.");
meRouter.patch(
  "/",
  asyncHandler(async (req, res) => {
    const { bookingUrl, ...prefs } = parseBody(updateMeSchema, req.body);
    if (bookingUrl !== undefined) await setBookingUrl(pool, req.actor!.id, bookingUrl);
    const saved = prefs.emailAlertsEnabled !== undefined || prefs.emailDigestEnabled !== undefined ? await setAlertPrefs(pool, req.actor!.id, prefs) : await getAlertPrefs(pool, req.actor!.id);
    res.json({ bookingUrl: bookingUrl !== undefined ? bookingUrl : await getBookingUrl(pool, req.actor!.id), ...saved });
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
