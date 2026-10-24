/**
 * CRM v2 companies (B4) and the admin duplicate review. Mounted inside crmRouter
 * (requireAuth + requireCrmUser + requireWorkspace); merge and duplicates are admin-only.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { requireAdmin } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import { parseBody, parseQuery, uuidParam } from "../validation/parse.js";
import * as records from "../services/companyRecords.service.js";
import * as duplicates from "../services/companyDuplicates.service.js";
import { mergeCompanies } from "../services/companies.service.js";
import { contactListSchema, listContacts } from "../services/contacts.service.js";
import { dealListSchema, listDeals } from "../services/dealRecords.service.js";

export const companiesRouter = Router();
companiesRouter.param("id", uuidParam("company"));

companiesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await records.listCompanies(pool, req.actor!, req.workspaceId!, parseQuery(records.companyListSchema, req.query)));
  }),
);

companiesRouter.get(
  "/count",
  asyncHandler(async (req, res) => {
    res.json(await records.countCompanies(pool, req.actor!, req.workspaceId!, parseQuery(records.companyFilterSchema, req.query)));
  }),
);

companiesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parseBody(records.createCompanySchema, req.body);
    res.status(201).json(await withTransaction((client) => records.createCompany(client, req.actor!, req.workspaceId!, input)));
  }),
);

companiesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await records.getCompany(pool, req.workspaceId!, req.params.id!));
  }),
);

companiesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const patch = parseBody(records.updateCompanySchema, req.body);
    res.json(await withTransaction((client) => records.updateCompany(client, req.workspaceId!, req.params.id!, patch)));
  }),
);

/** The company's contacts: the contacts list standard with companyId fixed. */
companiesRouter.get(
  "/:id/contacts",
  asyncHandler(async (req, res) => {
    const query = parseQuery(contactListSchema.omit({ companyId: true }), req.query);
    await records.assertCompanyUsable(pool, req.workspaceId!, req.params.id!);
    res.json(await listContacts(pool, req.actor!, req.workspaceId!, { ...query, companyId: req.params.id! }));
  }),
);

/** The company's deals: the deals list standard with companyId fixed. */
companiesRouter.get(
  "/:id/deals",
  asyncHandler(async (req, res) => {
    const query = parseQuery(dealListSchema.omit({ companyId: true }), req.query);
    await records.assertCompanyUsable(pool, req.workspaceId!, req.params.id!);
    res.json(await listDeals(pool, req.actor!, req.workspaceId!, { ...query, companyId: req.params.id! }));
  }),
);

companiesRouter.post(
  "/:id/merge",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { sourceId } = parseBody(z.object({ sourceId: z.string().uuid() }).strict(), req.body);
    res.json(await withTransaction((client) => mergeCompanies(client, req.actor!, req.workspaceId!, req.params.id!, sourceId)));
  }),
);

export const companyDuplicatesRouter = Router();
companyDuplicatesRouter.use(requireAdmin);
companyDuplicatesRouter.param("id", uuidParam("duplicate suggestion"));

companyDuplicatesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await duplicates.listDuplicates(pool, req.workspaceId!, parseQuery(duplicates.duplicateListSchema, req.query)));
  }),
);

companyDuplicatesRouter.post(
  "/:id/merge",
  asyncHandler(async (req, res) => {
    const { targetId } = parseBody(z.object({ targetId: z.string().uuid().optional() }).strict(), req.body ?? {});
    res.json(await withTransaction((client) => duplicates.mergeDuplicate(client, req.actor!, req.workspaceId!, req.params.id!, targetId)));
  }),
);

companyDuplicatesRouter.post(
  "/:id/dismiss",
  asyncHandler(async (req, res) => {
    await withTransaction((client) => duplicates.dismissDuplicate(client, req.actor!, req.workspaceId!, req.params.id!));
    res.status(204).end();
  }),
);

companyDuplicatesRouter.post(
  "/:id/relink",
  asyncHandler(async (req, res) => {
    const { companyId } = parseBody(z.object({ companyId: z.string().uuid().optional() }).strict(), req.body ?? {});
    res.json(await withTransaction((client) => duplicates.relinkDuplicate(client, req.actor!, req.workspaceId!, req.params.id!, companyId)));
  }),
);
