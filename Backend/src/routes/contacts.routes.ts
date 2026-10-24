/**
 * CRM v2 contacts (B4): lists, count, detail and bulk actions over `leads`.
 * Mounted inside crmRouter (requireAuth + requireCrmUser + requireWorkspace).
 * Single-contact writes stay on /leads/:id/... (no duplication).
 */
import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { pool } from "../db.js";
import { ForbiddenError } from "../errors.js";
import { parseBody, parseQuery, uuidParam } from "../validation/parse.js";
import * as contacts from "../services/contacts.service.js";

export const contactsRouter = Router();
contactsRouter.param("id", uuidParam("contact"));

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
