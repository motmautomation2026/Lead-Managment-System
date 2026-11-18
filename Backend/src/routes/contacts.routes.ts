/**
 * CRM v2 contacts (B4): lists, count, detail and bulk actions over `leads`.
 * Mounted inside crmRouter (requireAuth + requireCrmUser + requireWorkspace).
 * Single-contact writes stay on /leads/:id/... (no duplication).
 */
import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { pool, withTransaction } from "../db.js";
import { ConflictError, ForbiddenError, ValidationError } from "../errors.js";
import { parseBody, parseQuery, uuidParam } from "../validation/parse.js";
import * as contacts from "../services/contacts.service.js";
import { getLeadRowOr404 } from "../services/leads.service.js";
import { listContactTimeline, timelineListSchema } from "../services/timeline.service.js";
import { canReadReplies, readEmailReply, readInboundReply } from "../services/inboundReplies.service.js";
import { correctReplyLabel, replyLabelCorrectionSchema } from "../services/replyLabels.service.js";
import { discardReplyDraft, draftsForReplies, getLatestReplyDraft, sendReplyDraft } from "../services/replyDrafts.service.js";
import { z } from "zod";
import { requireAdmin } from "../authMiddleware.js";
import { changeLeadNumber } from "../services/whatsappNumbers.service.js";
import { assertCanSwitch, switchAutomation } from "../services/leadAutomation.service.js";
import { MAX_AUTOMATION_BATCH } from "../domain/automation.js";

/** E3b-2a: the rep's text (the word limit is checked by the service: 400 with the count). */
const replyDraftSendSchema = z.object({ body: z.string().max(5000) }).strict();

export const contactsRouter = Router();
contactsRouter.param("id", uuidParam("contact"));
contactsRouter.param("replyId", uuidParam("reply"));
contactsRouter.param("draftId", uuidParam("suggested reply"));

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

/**
 * REL-1 rule 2: switch automation on / off for contacts (admins: any; salespeople: their own). `ids` = one contact (the
 * contact page; 403 when not allowed) or a selection; /filtered = the whole filtered list (same query filters as
 * /contacts/count) and `expectedCount` must still match what the user confirmed (409 otherwise).
 */
const automationIdsSchema = z.object({ enabled: z.boolean(), ids: z.array(z.string().uuid()).min(1).max(MAX_AUTOMATION_BATCH) }).strict();
const automationFilteredSchema = z.object({ enabled: z.boolean(), expectedCount: z.number().int().min(1) }).strict();
contactsRouter.post(
  "/automation",
  asyncHandler(async (req, res) => {
    const { enabled, ids } = parseBody(automationIdsSchema, req.body);
    const result = await withTransaction(async (client) => {
      if (ids.length === 1) await assertCanSwitch(client, req.actor!, req.workspaceId!, ids[0]!);
      return switchAutomation(client, req.actor!, req.workspaceId!, ids, enabled);
    });
    res.json({ changed: result.changed.length, unchanged: result.unchanged });
  }),
);
contactsRouter.post(
  "/automation/filtered",
  asyncHandler(async (req, res) => {
    const filters = parseQuery(contacts.contactFilterSchema, req.query);
    const { enabled, expectedCount } = parseBody(automationFilteredSchema, req.body);
    const result = await withTransaction(async (client) => {
      const ids = await contacts.contactIdsForFilter(client, req.actor!, req.workspaceId!, filters, MAX_AUTOMATION_BATCH + 1);
      if (ids.length > MAX_AUTOMATION_BATCH) throw new ValidationError(`This list has more than ${MAX_AUTOMATION_BATCH} contacts. Narrow the filters first.`);
      if (ids.length !== expectedCount) throw new ConflictError(`${ids.length} contacts match these filters now (you confirmed ${expectedCount}). Check the list and try again.`);
      return switchAutomation(client, req.actor!, req.workspaceId!, ids, enabled, { audit: { filters } });
    });
    res.json({ changed: result.changed.length, unchanged: result.unchanged });
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
    const page = await listContactTimeline(pool, req.workspaceId!, req.params.id!, query, canReadReplies(req.actor!, lead.owner_id));
    // E3b-2a: each reply row's suggested reply (open or sent), for the owner and admins only.
    const replyIds = page.data.flatMap((row) => ("reply" in row && row.reply ? [row.reply.messageId] : []));
    const drafts = await draftsForReplies(pool, req.actor!, req.params.id!, lead.owner_id, replyIds);
    res.json({ ...page, data: page.data.map((row) => ("reply" in row && row.reply ? { ...row, reply: { ...row.reply, draft: drafts.get(row.reply.messageId) ?? null } } : row)) });
  }),
);

/** E4a rule 6: an admin moves the contact to another WhatsApp number (reason required; audited; timeline event). */
const whatsappNumberSchema = z.object({ numberId: z.string().uuid(), reason: z.string().trim().min(1, "A reason is required.").max(500) }).strict();
contactsRouter.post(
  "/:id/whatsapp-number",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await changeLeadNumber(req.actor!, req.workspaceId!, req.params.id!, parseBody(whatsappNumberSchema, req.body)));
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

/** E3b-2a: the contact's open (else latest sent) suggested reply, for the reply task's Sheet; owner + admins. */
contactsRouter.get(
  "/:id/reply-drafts/latest",
  asyncHandler(async (req, res) => {
    res.json({ draft: await getLatestReplyDraft(pool, req.actor!, req.workspaceId!, req.params.id!) });
  }),
);

/** E3b-2a: the owner or an admin sends an open suggested reply (as edited). Queued; the worker sends it. */
contactsRouter.post(
  "/:id/reply-drafts/:draftId/send",
  asyncHandler(async (req, res) => {
    const { body } = parseBody(replyDraftSendSchema, req.body);
    res.json(await sendReplyDraft(req.actor!, req.workspaceId!, req.params.id!, req.params.draftId!, body));
  }),
);

contactsRouter.post(
  "/:id/reply-drafts/:draftId/discard",
  asyncHandler(async (req, res) => {
    res.json(await discardReplyDraft(req.actor!, req.workspaceId!, req.params.id!, req.params.draftId!));
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
