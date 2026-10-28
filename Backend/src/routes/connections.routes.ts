import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { parseBody, parseQuery, uuidParam } from "../validation/parse.js";
import * as connections from "../services/connections.service.js";
import * as websiteLeadSettings from "../services/websiteLeadSettings.service.js";
import { requireAdmin } from "../authMiddleware.js";
import * as emailConnection from "../services/emailConnection.service.js";
import { getTestEmail, queueTestEmail } from "../services/emailOutbound.service.js";
import { checkDeliverability } from "../services/emailDeliverability.service.js";

/**
 * Workspace-scoped Email/WhatsApp/Google Calendar connection management.
 * Moved out of the admin-only app (see admin.routes.ts) per the
 * multi-workspace architecture plan: Admin stays limited to user
 * management, and every active CRM user can use the connections for whichever
 * workspace they currently have selected (requireWorkspace, applied at the
 * crmRouter level in routes/index.ts, resolves req.workspaceId). Email (E1b) and
 * WhatsApp safety (E1) settings are admin-only (requireAdmin below).
 */
export const connectionsRouter = Router();
connectionsRouter.param("testEmailId", uuidParam("test email"));

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour).");

// E1b email: SMTP only. Every CRM user may read the settings (no secrets) and the monitoring;
// everything else is admin-only. Sending happens only in the worker.
connectionsRouter.get("/email/settings", asyncHandler(async (req, res) => res.json(await emailConnection.getEmailSettings(req.workspaceId!))));

const port = z.number().int().min(1).max(65535);
const security = z.enum(["ssl", "starttls"]);
const emailSettingsSchema = z
  .object({
    provider: z.literal("smtp", { errorMap: () => ({ message: "Email goes through SMTP only; Resend is no longer supported." }) }).optional(),
    enabled: z.boolean(),
    smtpHost: z.string().trim().min(1, "The SMTP host is required.").max(255),
    smtpPort: port,
    smtpSecurity: security,
    smtpUsername: z.string().max(320).optional(),
    smtpPassword: z.string().max(1000).optional(),
    fromAddress: z.string().trim().email("Enter a valid from address."),
    fromName: z.string().trim().min(1, "The from name is required.").max(120),
    replyTo: z.union([z.string().trim().email("Enter a valid reply-to address."), z.literal(""), z.null()]).optional(),
    imapHost: z.string().trim().min(1, "The IMAP host is required.").max(255),
    imapPort: port,
    imapSecurity: security,
    imapSameLogin: z.boolean(),
    imapUsername: z.string().max(320).optional(),
    imapPassword: z.string().max(1000).optional(),
    imapFolder: z.string().trim().min(1).max(255).default("INBOX"),
    dailyCap: z.number().int().min(1).max(10_000),
    hourlyCap: z.number().int().min(1).max(1000),
    minDelaySeconds: z.number().int().min(1).max(3600),
    maxDelaySeconds: z.number().int().min(1).max(3600),
    sendWindow: z
      .object({ days: z.array(z.number().int().min(1).max(7)).min(1).max(7), start: hhmm, end: hhmm })
      .refine((w) => w.start < w.end, { message: "The send window must start before it ends.", path: ["end"] }),
    alreadyWarmed: z.boolean(),
  })
  .refine((s) => s.minDelaySeconds <= s.maxDelaySeconds, { message: "The minimum spacing can't be more than the maximum.", path: ["maxDelaySeconds"] });
connectionsRouter.put(
  "/email/settings",
  requireAdmin,
  asyncHandler(async (req, res) =>
    res.json(await emailConnection.updateEmailSettings(req.actor!, req.workspaceId!, parseBody(emailSettingsSchema, req.body))),
  ),
);
connectionsRouter.post("/email/resume", requireAdmin, asyncHandler(async (req, res) => res.json(await emailConnection.resumeEmail(req.actor!, req.workspaceId!))));
connectionsRouter.post("/email/test-smtp", requireAdmin, asyncHandler(async (req, res) => res.json(await emailConnection.testSmtpLogin(req.actor!, req.workspaceId!))));
connectionsRouter.post("/email/test-imap", requireAdmin, asyncHandler(async (req, res) => res.json(await emailConnection.testImapLogin(req.actor!, req.workspaceId!))));
connectionsRouter.post(
  "/email/test-send",
  requireAdmin,
  asyncHandler(async (req, res) => res.status(202).json(await queueTestEmail(req.workspaceId!, req.actor!))),
);
connectionsRouter.get(
  "/email/test-send/:testEmailId",
  requireAdmin,
  asyncHandler(async (req, res) => res.json(await getTestEmail(req.workspaceId!, req.params.testEmailId!))),
);
const deliverabilitySchema = z
  .object({ selector: z.union([z.literal(""), z.string().trim().regex(/^[A-Za-z0-9._-]{1,63}$/, 'Enter a DKIM selector like "google" or "s1".')]).optional() })
  .strict();
connectionsRouter.get(
  "/email/deliverability",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { selector } = parseQuery(deliverabilitySchema, req.query);
    res.json(await checkDeliverability(req.workspaceId!, selector || null));
  }),
);

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
