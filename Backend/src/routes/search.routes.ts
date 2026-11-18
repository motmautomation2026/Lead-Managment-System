/**
 * CRM v2 global search and saved views (B4). Mounted inside crmRouter
 * (requireAuth + requireCrmUser + requireWorkspace).
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { pool, withTransaction } from "../db.js";
import { parseBody, parseQuery, uuidParam } from "../validation/parse.js";
import { searchQuery } from "../lists/listQuery.js";
import { globalSearch } from "../services/search.service.js";
import * as views from "../services/savedViews.service.js";

export const searchRouter = Router();

searchRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { q } = parseQuery(z.object({ q: searchQuery }).strict(), req.query);
    res.json(await globalSearch(pool, req.workspaceId!, q));
  }),
);

export const savedViewsRouter = Router();
savedViewsRouter.param("id", uuidParam("saved view"));

savedViewsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { object } = parseQuery(views.listViewsSchema, req.query);
    res.json(await views.listViews(pool, req.actor!, req.workspaceId!, object));
  }),
);

savedViewsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = parseBody(views.createViewSchema, req.body);
    res.status(201).json(await withTransaction((client) => views.createView(client, req.actor!, req.workspaceId!, input)));
  }),
);

savedViewsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const patch = parseBody(views.updateViewSchema, req.body);
    res.json(await withTransaction((client) => views.updateView(client, req.actor!, req.workspaceId!, req.params.id!, patch)));
  }),
);

savedViewsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await withTransaction((client) => views.deleteView(client, req.actor!, req.workspaceId!, req.params.id!));
    res.status(204).end();
  }),
);
