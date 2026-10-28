/**
 * CRM v2 contacts (B4): lists, count, detail and bulk actions over `leads`.
 * Mounted inside crmRouter (requireAuth + requireCrmUser + requireWorkspace).
 * Single-contact writes stay on /leads/:id/... (no duplication).
 */
import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { pool, withTransaction } from "../db.js";
import { ForbiddenError } from "../errors.js";
import { parseBody, parseQuery, uuidParam } from "../validation/parse.js";
import * as contacts from "../services/contacts.service.js";
import { getLeadRowOr404 } from "../services/leads.service.js";
import { listContactTimeline, timelineListSchema } from "../services/timeline.service.js";
import { canReadReplies, readEmailReply, readInboundReply } from "../services/inboundReplies.service.js";
import { correctReplyLabel, replyLabelCorrectionSchema } from "../services/replyLabels.service.js";

export const contactsRouter = Router();
contactsRouter.param("id", uuidParam("contact"));
contactsRouter.param("replyId", uuidParam("reply"));

contactsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await contacts.listContacts(pool, req.actor!, req.workspaceId!, parseQuery(contacts.contactListSchema, req.query)));
  }),
);

contactsRouter.get(
  "/count",
  asyncHandler(async (req, res) => {
    res.json(await contacts.countContacts(pool, req.actor!, req.workspaceId!, parseQuery(contacts.contactFilterSchema, req.query)));
  }),
);

contactsRouter.post(
  "/bulk",
  asyncHandler(async (req, res) => {
    const input = parseBody(contacts.contactBulkSchema, req.body);
    if (input.action === "enrollAi" && req.actor!.role !== "admin") throw new ForbiddenError("Administrator access is required.");
    res.json({ data: await contacts.bulkContacts(pool, req.actor!, req.workspaceId!, input) });
  }),
);

contactsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await contacts.getContact(pool, req.workspaceId!, req.params.id!));
  }),
);

/** The contact's timeline, paginated newest first (the old GET /leads/:id/timeline is unchanged). */
contactsRouter.get(
  "/:id/timeline",
  asyncHandler(async (req, res) => {
    const query = parseQuery(timelineListSchema, req.query);
    const lead = await getLeadRowOr404(pool, req.workspaceId!, req.params.id!);
    res.json(await listContactTimeline(pool, req.workspaceId!, req.params.id!, query, canReadReplies(req.actor!, lead.owner_id)));
  }),
);

/** D2: one inbound WhatsApp reply's text (owner + admins, audited). Never cached, never logged. */
contactsRouter.get(
  "/:id/replies/:messageId",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await readInboundReply(pool, req.actor!, req.workspaceId!, req.params.id!, req.params.messageId!));
  }),
);

/** D4a: the owner or an admin changes a reply's label (no text involved). */
contactsRouter.put(
  "/:id/replies/:messageId/label",
  asyncHandler(async (req, res) => {
    const { label } = parseBody(replyLabelCorrectionSchema, req.body);
    res.json(await withTransaction((client) => correctReplyLabel(client, req.actor!, req.workspaceId!, req.params.id!, req.params.messageId!, label)));
  }),
);

/** D3: one email reply's subject + text (owner + admins, audited). Never cached, never logged. */
contactsRouter.get(
  "/:id/email-replies/:replyId",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await readEmailReply(pool, req.actor!, req.workspaceId!, req.params.id!, req.params.replyId!));
  }),
);

/** D3: the owner or an admin changes an email reply's label (same rules as WhatsApp's). */
contactsRouter.put(
  "/:id/email-replies/:replyId/label",
  asyncHandler(async (req, res) => {
    const { label } = parseBody(replyLabelCorrectionSchema, req.body);
    res.json(await withTransaction((client) => correctReplyLabel(client, req.actor!, req.workspaceId!, req.params.id!, req.params.replyId!, label, "email")));
  }),
);
