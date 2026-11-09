/**
 * E4b rules 9–10: workspace members (Settings → Team for the workspace's admins, the super-admin page for
 * every workspace). Every change is audited in workspace_member_events. Creating user accounts stays in /admin.
 */
import { z } from "zod";
import type { Actor } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { TERMINAL_LIFECYCLE_STATES } from "../domain/enums.js";
import { changeRoleProblem, removeMemberProblem, type MemberRow, type OwnedWork, type WorkspaceRole } from "../domain/workspaceAccess.js";
import { pageParams, runPage, SqlBuilder, defineSorts, sortParam, containsPattern, searchQuery } from "../lists/listQuery.js";
import { recordMemberEvent } from "./workspaces.service.js";

export const workspaceRole = z.enum(["admin", "salesperson"]);
export const addMemberSchema = z.object({ email: z.string().trim().email(), role: workspaceRole }).strict();
export const changeRoleSchema = z.object({ role: workspaceRole }).strict();
export const setMembershipSchema = z.object({ workspaceId: z.string().uuid(), userId: z.string().uuid(), role: workspaceRole.nullable() }).strict();

/** The members of one workspace with their role, oldest member first. */
export async function listMembers(workspaceId: string, db: Queryable = pool) {
  const rows = await db.query<{ user_id: string; full_name: string; email: string; is_active: boolean; role: WorkspaceRole; created_at: Date }>(
    `select m.user_id, p.full_name, p.email, p.is_active, m.role, m.created_at
       from public.workspace_members m join public.profiles p on p.id = m.user_id
      where m.workspace_id = $1
      order by m.created_at, p.full_name`,
    [workspaceId],
  );
  return rows.rows.map((r) => ({ userId: r.user_id, name: r.full_name, email: r.email, active: r.is_active, role: r.role, since: r.created_at.toISOString() }));
}

/** Rows locked for the change (serialises concurrent member edits of one workspace). */
async function lockMembers(db: Queryable, workspaceId: string): Promise<MemberRow[]> {
  const ws = await db.query(`select 1 from public.workspaces where id = $1 for update`, [workspaceId]);
  if (!ws.rowCount) throw new NotFoundError("Workspace");
  const rows = await db.query<{ user_id: string; role: WorkspaceRole }>(`select user_id, role from public.workspace_members where workspace_id = $1`, [workspaceId]);
  return rows.rows.map((r) => ({ userId: r.user_id, role: r.role }));
}

async function ownedWork(db: Queryable, workspaceId: string, userId: string): Promise<OwnedWork> {
  const row = (
    await db.query<OwnedWork>(
      `select (select count(*)::int from public.leads where workspace_id = $1 and owner_id = $2
                 and lifecycle_state <> 'merged' and not (lifecycle_state::text = any($3::text[]))) as contacts,
              (select count(*)::int from public.deals where workspace_id = $1 and owner_id = $2 and stage not in ('won', 'lost')) as deals,
              (select count(*)::int from public.tasks where workspace_id = $1 and owner_id = $2 and status = 'open') as tasks`,
      [workspaceId, userId, TERMINAL_LIFECYCLE_STATES],
    )
  ).rows[0]!;
  return row;
}

/** Adds an existing ACTIVE user (by email) to the workspace. */
export async function addMember(actor: Actor, workspaceId: string, input: z.infer<typeof addMemberSchema>) {
  return withTransaction(async (db) => {
    const members = await lockMembers(db, workspaceId);
    const user = (await db.query<{ id: string }>(`select id from public.profiles where lower(email) = lower($1) and is_active`, [input.email])).rows[0];
    if (!user) throw new NotFoundError("Active user with this email");
    if (members.some((m) => m.userId === user.id)) throw new ConflictError("This user is already a member of this workspace.");
    await db.query(`insert into public.workspace_members (workspace_id, user_id, role, created_by) values ($1, $2, $3, $4)`, [workspaceId, user.id, input.role, actor.id]);
    await recordMemberEvent(db, actor, workspaceId, user.id, "added", null, input.role);
    return listMembers(workspaceId, db);
  });
}

/** Changes a member's role; never demotes the last admin. */
export async function changeMemberRole(actor: Actor, workspaceId: string, userId: string, role: WorkspaceRole) {
  return withTransaction(async (db) => {
    const members = await lockMembers(db, workspaceId);
    const problem = changeRoleProblem(members, userId, role);
    if (problem) throw members.some((m) => m.userId === userId) ? new ConflictError(problem) : new NotFoundError("Member");
    const old = members.find((m) => m.userId === userId)!.role;
    if (old !== role) {
      await db.query(`update public.workspace_members set role = $3, updated_at = now() where workspace_id = $1 and user_id = $2`, [workspaceId, userId, role]);
      await recordMemberEvent(db, actor, workspaceId, userId, "role_changed", old, role);
    }
    return listMembers(workspaceId, db);
  });
}

/** Removes a member; blocked (409, with counts) while they own active work here, and for the last admin. */
export async function removeMember(actor: Actor, workspaceId: string, userId: string) {
  return withTransaction(async (db) => {
    const members = await lockMembers(db, workspaceId);
    if (!members.some((m) => m.userId === userId)) throw new NotFoundError("Member");
    const problem = removeMemberProblem(members, userId, await ownedWork(db, workspaceId, userId));
    if (problem) throw new ConflictError(problem);
    const old = members.find((m) => m.userId === userId)!.role;
    await db.query(`delete from public.workspace_members where workspace_id = $1 and user_id = $2`, [workspaceId, userId]);
    await recordMemberEvent(db, actor, workspaceId, userId, "removed", old, null);
    return listMembers(workspaceId, db);
  });
}

// --- Super-admin (rule 10) ------------------------------------------------------

const USER_SORTS = defineSorts({ fields: { name: { columns: ["p.full_name"], type: "text" } }, idColumn: "p.id", defaultSort: "name:asc" });
export const membershipListSchema = z.object({ ...pageParams, sort: sortParam(USER_SORTS), q: searchQuery.optional() }).strict();

/**
 * Every active workspace (columns) × active users (rows, a keyset page by name) with their role in each.
 * shortcut: every workspace is a column; fine for tens of workspaces, page them if that grows.
 */
export async function listMemberships(query: z.infer<typeof membershipListSchema>, db: Queryable = pool) {
  const workspaces = (await db.query<{ id: string; name: string }>(`select id, name from public.workspaces where is_active order by created_at`)).rows;
  const b = new SqlBuilder();
  b.and("p.is_active");
  if (query.q) {
    const pattern = b.p(containsPattern(query.q));
    b.and(`(p.full_name ilike ${pattern} or p.email ilike ${pattern})`);
  }
  const page = await runPage<{ id: string; name: string; email: string; isSuperAdmin: boolean; roles: Record<string, WorkspaceRole> }>(
    db,
    b,
    query.sort,
    query,
    ({ where, orderBy, limit, cursorSelect }) =>
      `select p.id, p.full_name as name, p.email, p.is_super_admin as "isSuperAdmin",
              coalesce((select jsonb_object_agg(m.workspace_id, m.role) from public.workspace_members m where m.user_id = p.id), '{}'::jsonb) as roles,
              ${cursorSelect}
         from public.profiles p ${where} order by ${orderBy} limit ${limit}`,
  );
  return { workspaces, ...page };
}

/** Sets one user's membership in one workspace: a role adds or changes it, null removes it (rule 9 guards apply). */
export async function setMembership(actor: Actor, input: z.infer<typeof setMembershipSchema>) {
  if (input.role === null) return removeMember(actor, input.workspaceId, input.userId);
  const isMember = await pool.query(`select 1 from public.workspace_members where workspace_id = $1 and user_id = $2`, [input.workspaceId, input.userId]);
  if (isMember.rowCount) return changeMemberRole(actor, input.workspaceId, input.userId, input.role);
  const user = (await pool.query<{ email: string }>(`select email from public.profiles where id = $1 and is_active`, [input.userId])).rows[0];
  if (!user) throw new NotFoundError("Active user");
  return addMember(actor, input.workspaceId, { email: user.email, role: input.role });
}
