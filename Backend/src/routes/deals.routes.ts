/**
 * CRM v2 deals (B4): list, count, board, detail, manual create, edit and stage moves.
 * Mounted inside crmRouter (requireAuth + requireCrmUser + requireWorkspace).
 */
import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { pool, withTransaction } from "../db.js";
import { ValidationError } from "../errors.js";
import { parseBody, parseQuery, uuidParam } from "../validation/parse.js";
import * as deals from "../services/dealRecords.service.js";

export const dealsRouter = Router();
dealsRouter.param("id", uuidParam("deal"));

dealsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await deals.listDeals(pool, req.actor!, req.workspaceId!, parseQuery(deals.dealListSchema, req.query)));
  }),
);

dealsRouter.get(
  "/count",
  asyncHandler(async (req, res) => {
    res.json(await deals.countDeals(pool, req.actor!, req.workspaceId!, parseQuery(deals.dealFilterSchema, req.query)));
  }),
);

dealsRouter.get(
  "/board",
  asyncHandler(async (req, res) => {
    res.json(await deals.dealBoard(pool, req.actor!, req.workspaceId!, parseQuery(deals.dealBoardSchema, req.query)));
  }),
);

dealsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parseBody(deals.createDealSchema, req.body);
    res.status(201).json(await withTransaction((client) => deals.createManualDeal(client, req.actor!, req.workspaceId!, input)));
  }),
);

dealsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await deals.getDeal(pool, req.workspaceId!, req.params.id!));
  }),
);

dealsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (req.body && typeof req.body === "object" && "stage" in req.body) {
      throw new ValidationError("Change a deal's stage with POST /deals/:id/stage.", { field: "stage" });
    }
    const patch = parseBody(deals.updateDealSchema, req.body);
    res.json(await withTransaction((client) => deals.updateDeal(client, req.workspaceId!, req.params.id!, patch)));
  }),
);

dealsRouter.post(
  "/:id/stage",
  asyncHandler(async (req, res) => {
    const input = parseBody(deals.moveStageSchema, req.body);
    res.json(await withTransaction((client) => deals.moveDeal(client, req.actor!, req.workspaceId!, req.params.id!, input)));
  }),
);
