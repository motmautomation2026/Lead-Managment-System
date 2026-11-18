import type { NextFunction, Request, Response } from "express";
import { pool } from "./db.js";
import { supabaseAdmin } from "./supabaseAdmin.js";
import { AuthenticationError, ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { isUuid } from "./validation/parse.js";
import { asyncHandler } from "./asyncHandler.js";
import { effectiveWorkspaceRole, NO_WORKSPACE_ACCESS_MESSAGE, type WorkspaceRole } from "./domain/workspaceAccess.js";

/** The authenticated CRM actor (salesperson or admin) for the lifetime of one request. */
export interface Actor {
  id: string;
  fullName: string;
  email: string;
  isActive: boolean;
  /** Global profile role until requireWorkspace replaces it with the role in that workspace (E4b). */
  role: "admin" | "salesperson";
  /** E4b: opens every workspace as admin (profiles.is_super_admin). */
  isSuperAdmin?: boolean;
}

declare module "express-serve-static-core" {
  interface Request {
    actor?: Actor;
    workspaceId?: string;
    /** Set by requestIdMiddleware; returned on 500s so a user can quote it. */
    requestId?: string;
  }
}

/**
 * Establishes the authenticated CRM user for a request:
 *  1. Verify the bearer token against Supabase Auth (proves the caller owns
 *     a real session issued by our auth foundation — we never trust a
 *     client-supplied user id).
 *  2. Load the matching CRM profile and require is_active — a disabled
 *     salesperson's token must not grant CRM access, even if it's still a
 *     technically-valid Supabase session (Rule: security-sensitive data
 *     must never be trusted merely because the browser sent it).
 *
 * On success, req.actor is populated and every downstream handler/service
 * uses it for ownership/attribution — never a client-supplied "userId".
 */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  if (req.actor) {
    next();
    return;
  }

  const header = req.header("authorization") ?? req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
  if (!token) {
    throw new AuthenticationError("Missing bearer token.");
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    throw new AuthenticationError("Invalid or expired session.");
  }

  const result = await pool.query<{
    id: string;
    full_name: string;
    email: string;
    is_active: boolean;
    role: "admin" | "salesperson";
    is_super_admin: boolean;
  }>(`select id, full_name, email, is_active, role, is_super_admin from public.profiles where id = $1`, [data.user.id]);

  const profile = result.rows[0];
  if (!profile) {
    throw new AuthenticationError("No CRM profile for this account.");
  }
  if (!profile.is_active) {
    throw new ForbiddenError("This account has been deactivated.");
  }

  req.actor = {
    id: profile.id,
    fullName: profile.full_name,
    email: profile.email,
    isActive: profile.is_active,
    role: profile.role,
    isSuperAdmin: profile.is_super_admin,
  };
  next();
});

/**
 * Admin-only. Inside the CRM router (after requireWorkspace) `role` is the role in THAT workspace (E4b);
 * on /admin (user management, no workspace) it is the global profile role. A super-admin always passes.
 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.actor?.role !== "admin" && !req.actor?.isSuperAdmin) {
    next(new ForbiddenError("Administrator access is required."));
    return;
  }
  next();
}

/** E4b: super-admin only (rule 10: every workspace and membership). */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.actor?.isSuperAdmin) {
    next(new ForbiddenError("Super-admin access is required."));
    return;
  }
  next();
}

/** Any CRM user: admins can do everything a salesperson can. Must run after requireAuth. */
export function requireCrmUser(req: Request, _res: Response, next: NextFunction) {
  if (req.actor?.role !== "salesperson" && req.actor?.role !== "admin") {
    next(new ForbiddenError("This account cannot access the CRM."));
    return;
  }
  next();
}

/**
 * E4b rule 3, the ONE workspace access check: resolves `X-Workspace-Id` (sent by
 * Frontend/src/lib/backend-client.ts on every request) to an active workspace the user is a member of
 * (or any, for a super-admin; 403 otherwise) and replaces `req.actor.role` with the role in that
 * workspace, so every requireAdmin / `actor.role` check downstream is per workspace.
 * Must run after requireAuth + requireCrmUser.
 */
export const requireWorkspace = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.header("x-workspace-id");
  if (!header) {
    throw new NotFoundError("Workspace");
  }
  if (!isUuid(header)) {
    throw new ValidationError("Invalid workspace id.");
  }
  const actor = req.actor!;
  const result = await pool.query<{ id: string; role: WorkspaceRole | null }>(
    `select w.id, m.role
       from public.workspaces w
       left join public.workspace_members m on m.workspace_id = w.id and m.user_id = $2
      where w.id = $1 and w.is_active = true`,
    [header, actor.id],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("Workspace");
  }
  const role = effectiveWorkspaceRole(row.role, actor.isSuperAdmin === true);
  if (!role) {
    throw new ForbiddenError(NO_WORKSPACE_ACCESS_MESSAGE);
  }
  req.workspaceId = row.id;
  // A copy: the actor object may be shared (tests set req.actor directly).
  req.actor = { ...actor, role };
  next();
});
