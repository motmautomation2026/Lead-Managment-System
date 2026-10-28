import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { parseBody } from "../validation/parse.js";
import * as connections from "../services/connections.service.js";
import * as websiteLeadSettings from "../services/websiteLeadSettings.service.js";
import { requireAdmin } from "../authMiddleware.js";

/**
 * Workspace-scoped Email/WhatsApp/Google Calendar connection management.
 * Moved out of the admin-only app (see admin.routes.ts) per the
 * multi-workspace architecture plan: Admin stays limited to user
 * management, and every active CRM user can configure the connections
 * for whichever workspace they currently have selected (requireWorkspace,
 * applied at the crmRouter level in routes/index.ts, resolves req.workspaceId).
 */
export const connectionsRouter = Router();

// Who owns leads that arrive from the public website form (Settings -> Website leads).
connectionsRouter.get(
  "/website-leads",
  asyncHandler(async (req, res) => res.json(await websiteLeadSettings.getWebsiteLeadSettings(req.workspaceId!))),
);
const websiteLeadsSchema = z.object({ defaultOwnerId: z.string().uuid().nullable() });
connectionsRouter.put(
  "/website-leads",
  asyncHandler(async (req, res) =>
    res.json(await websiteLeadSettings.updateWebsiteLeadSettings(req.actor!, req.workspaceId!, parseBody(websiteLeadsSchema, req.body))),
  ),
);

connectionsRouter.get(
  "/whatsapp/settings",
  asyncHandler(async (req, res) => res.json(await connections.getWhatsAppConnection(req.workspaceId!))),
);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour).");
const whatsappSettingsSchema = z
  .object({
    enabled: z.boolean(),
    dailyCap: z.number().int().min(1).max(10_000),
    minDelaySeconds: z.number().int().min(1).max(300).optional(),
    maxDelaySeconds: z.number().int().min(1).max(600).optional(),
    maxNewChatsPerDay: z.number().int().min(0).max(1000).optional(),
    sendWindow: z
      .object({ days: z.array(z.number().int().min(1).max(7)).min(1).max(7), start: hhmm, end: hhmm })
      .refine((w) => w.start < w.end, { message: "The send window must start before it ends.", path: ["end"] })
      .optional(),
  })
  .refine((s) => s.minDelaySeconds === undefined || s.maxDelaySeconds === undefined || s.minDelaySeconds <= s.maxDelaySeconds, {
    message: "The minimum spacing can't be more than the maximum.",
    path: ["maxDelaySeconds"],
  });
// E1: WhatsApp safety settings, the emergency switch and resume are admin-only; connect/restart/logout stay open.
connectionsRouter.put(
  "/whatsapp/settings",
  requireAdmin,
  asyncHandler(async (req, res) =>
    res.json(await connections.updateWhatsAppSettings(req.actor!, req.workspaceId!, parseBody(whatsappSettingsSchema, req.body))),
  ),
);
connectionsRouter.post(
  "/whatsapp/resume",
  requireAdmin,
  asyncHandler(async (req, res) => res.json(await connections.resumeWhatsApp(req.actor!, req.workspaceId!))),
);

for (const command of ["connect", "restart", "logout"] as const) {
  connectionsRouter.post(
    `/whatsapp/${command}`,
    asyncHandler(async (req, res) => res.json(await connections.commandWhatsApp(req.actor!, req.workspaceId!, command))),
  );
}

connectionsRouter.get(
  "/google-calendar",
  asyncHandler(async (req, res) => res.json(await connections.getGoogleCalendarConnection(req.workspaceId!))),
);
const googleCalendarCredentialsSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().optional(),
  redirectUri: z.string().trim().url(),
});
connectionsRouter.put(
  "/google-calendar/credentials",
  asyncHandler(async (req, res) =>
    res.json(await connections.updateGoogleCalendarCredentials(req.actor!, req.workspaceId!, parseBody(googleCalendarCredentialsSchema, req.body))),
  ),
);
connectionsRouter.post(
  "/google-calendar/oauth/start",
  asyncHandler(async (req, res) => res.json(await connections.startGoogleCalendarOAuth(req.actor!, req.workspaceId!))),
);
connectionsRouter.post(
  "/google-calendar/disconnect",
  asyncHandler(async (req, res) => res.json(await connections.disconnectGoogleCalendar(req.actor!, req.workspaceId!))),
);
