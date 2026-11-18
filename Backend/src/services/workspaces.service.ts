import type { Actor } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { recordAdminAudit } from "./admin-audit.service.js";
import { effectiveWorkspaceRole, type WorkspaceRole } from "../domain/workspaceAccess.js";

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export function workspaceToDto(row: WorkspaceRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "workspace";
}

/** E4b rule 4: the actor's workspaces with their role there (a super-admin: every workspace, as admin). */
export async function listWorkspaces(actor: Pick<Actor, "id" | "isSuperAdmin">, db: Queryable = pool) {
  const result = await db.query<WorkspaceRow & { role: WorkspaceRole | null }>(
    `select w.*, m.role
       from public.workspaces w
       left join public.workspace_members m on m.workspace_id = w.id and m.user_id = $1
      where w.is_active = true and (m.user_id is not null or $2)
      order by w.created_at asc`,
    [actor.id, actor.isSuperAdmin === true],
  );
  return result.rows.map((row) => ({ ...workspaceToDto(row), role: effectiveWorkspaceRole(row.role, actor.isSuperAdmin === true)! }));
}

/** E4b: one row in the membership audit (who, what, when). */
export async function recordMemberEvent(
  db: Queryable,
  actor: Pick<Actor, "id" | "email">,
  workspaceId: string,
  userId: string | null,
  action: "added" | "role_changed" | "removed" | "workspace_created",
  oldRole: WorkspaceRole | null,
  newRole: WorkspaceRole | null,
) {
  await db.query(
    `insert into public.workspace_member_events (workspace_id, user_id, action, old_role, new_role, actor_id, actor_email)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [workspaceId, userId, action, oldRole, newRole, actor.id, actor.email],
  );
}

async function uniqueSlug(db: Queryable, name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  for (;;) {
    const existing = await db.query<{ id: string }>(`select id from public.workspaces where slug = $1`, [candidate]);
    if (!existing.rows[0]) return candidate;
    candidate = `${base}-${suffix++}`;
  }
}

/**
 * Creates a workspace and seeds its per-workspace integration connection
 * rows (email/WhatsApp/Google Calendar), all disabled/unconfigured by
 * default — every reader in connections.service.ts assumes exactly one row
 * per workspace exists in each of these tables (mirroring how
 * 003_admin_integrations_baileys.sql and 006_google_calendar_meeting_sync.sql
 * originally seeded the single global row), so a workspace without these
 * rows would make those reads fail.
 */
export async function createWorkspace(actor: Actor, input: { name: string }) {
  const name = input.name.trim();
  if (!name) throw new ValidationError("Workspace name is required.", { field: "name" });

  return withTransaction(async (db) => {
    const existing = await db.query<{ id: string }>(`select id from public.workspaces where lower(name) = lower($1)`, [name]);
    if (existing.rows[0]) throw new ConflictError(`A workspace named "${name}" already exists.`, { field: "name" });

    const slug = await uniqueSlug(db, name);
    const result = await db.query<WorkspaceRow>(
      `insert into public.workspaces (id, name, slug) values (gen_random_uuid(), $1, $2) returning *`,
      [name, slug],
    );
    const workspace = result.rows[0]!;

    await db.query(`insert into public.integration_connections (workspace_id, id) values ($1, 'email')`, [workspace.id]);
    await db.query(`insert into public.whatsapp_connection (workspace_id) values ($1)`, [workspace.id]);
    // E4a: every workspace starts with WhatsApp number #1 (not paired).
    await db.query(`insert into public.whatsapp_numbers (workspace_id, label) values ($1, '#1')`, [workspace.id]);
    await db.query(`insert into public.google_calendar_connection (workspace_id) values ($1)`, [workspace.id]);

    await recordAdminAudit(db, actor, "workspace.created", "workspace", workspace.id, { name: workspace.name });
    // E4b rule 11: the creator becomes its admin (a super-admin too: never auto-added anywhere else).
    await db.query(`insert into public.workspace_members (workspace_id, user_id, role, created_by) values ($1, $2, 'admin', $2)`, [workspace.id, actor.id]);
    await recordMemberEvent(db, actor, workspace.id, actor.id, "workspace_created", null, "admin");

    return { ...workspaceToDto(workspace), role: "admin" as const };
  });
}

export async function renameWorkspace(actor: Actor, id: string, input: { name: string }) {
  const name = input.name.trim();
  if (!name) throw new ValidationError("Workspace name is required.", { field: "name" });

  return withTransaction(async (db) => {
    const current = await db.query<WorkspaceRow>(`select * from public.workspaces where id = $1`, [id]);
    if (!current.rows[0]) throw new NotFoundError("Workspace");

    const existing = await db.query<{ id: string }>(
      `select id from public.workspaces where lower(name) = lower($1) and id <> $2`,
      [name, id],
    );
    if (existing.rows[0]) throw new ConflictError(`A workspace named "${name}" already exists.`, { field: "name" });

    const result = await db.query<WorkspaceRow>(
      `update public.workspaces set name = $2 where id = $1 returning *`,
      [id, name],
    );
    await recordAdminAudit(db, actor, "workspace.renamed", "workspace", id, { name });
    return workspaceToDto(result.rows[0]!);
  });
}
