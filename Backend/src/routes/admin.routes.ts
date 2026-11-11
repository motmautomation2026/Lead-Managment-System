import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { requireAdmin, requireAuth } from "../authMiddleware.js";
import { parseBody, parseParams, parseQuery, uuidParam } from "../validation/parse.js";
import * as users from "../services/admin-users.service.js";
import { bookingUrlSchema } from "../services/profiles.service.js";

/**
 * Admin is intentionally limited to user management only (see the
 * multi-workspace architecture plan). Email/WhatsApp/Google Calendar
 * connection management moved to the workspace-scoped
 * routes/connections.routes.ts, reachable by any active CRM user for
 * whichever workspace they currently have selected — it is no longer an
 * admin-only concern.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);
adminRouter.param("id", uuidParam("user"));

// UX-1: keyset pages, newest first (`q`, `cursor`, `limit`).
adminRouter.get("/users", asyncHandler(async (req, res) => res.json(await users.listSalespeoplePage(parseQuery(users.userListSchema, req.query)))));

const createUserSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().email(),
  password: z.string().min(12),
});
adminRouter.post(
  "/users",
  asyncHandler(async (req, res) => {
    const user = await users.createSalesperson(req.actor!, parseBody(createUserSchema, req.body));
    res.status(201).json(user);
  }),
);

const updateUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(12).optional(),
  active: z.boolean().optional(),
  // E3b-1 rule 5: an admin can set a salesperson's booking link.
  bookingUrl: bookingUrlSchema.optional(),
});
adminRouter.patch(
  "/users",
  asyncHandler(async (req, res) => res.json(await users.updateSalesperson(req.actor!, parseBody(updateUserSchema, req.body)))),
);
const userIdParamsSchema = z.object({ id: z.string().uuid() });
adminRouter.patch(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const { id } = parseParams(userIdParamsSchema, req.params);
    const input = parseBody(updateUserSchema.omit({ id: true }), req.body);
    res.json(await users.updateSalesperson(req.actor!, { id, ...input }));
  }),
);
