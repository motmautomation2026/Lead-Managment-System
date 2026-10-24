/**
 * CRM v2 saved views (B4). `filters` and `sort` are stored exactly as the list endpoint's
 * query params (strings / string arrays, e.g. {"ownerId": "me"}) and validated by THE SAME
 * Zod schemas as that object's list; `columns` are known column ids for the object.
 * Owners manage their views; admins may also edit/delete shared ones. Max 30 per user per object.
 */
import { z } from "zod";
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { CONTACT_COLUMNS, contactFilterSchema, contactSortSchema } from "./contacts.service.js";
import { COMPANY_COLUMNS, companyFilterSchema, companySortSchema } from "./companyRecords.service.js";
import { DEAL_COLUMNS, dealFilterSchema, dealSortSchema } from "./dealRecords.service.js";

export const MAX_VIEWS_PER_OBJECT = 30;

const OBJECTS = {
  contacts: { filters: contactFilterSchema, sort: contactSortSchema, columns: CONTACT_COLUMNS as readonly string[] },
  companies: { filters: companyFilterSchema, sort: companySortSchema, columns: COMPANY_COLUMNS as readonly string[] },
  deals: { filters: dealFilterSchema, sort: dealSortSchema, columns: DEAL_COLUMNS as readonly string[] },
};
const viewObject = z.enum(["contacts", "companies", "deals"]);
type ViewObject = z.infer<typeof viewObject>;

const viewFields = {
  name: z.string().trim().min(1).max(100),
  filters: z.record(z.unknown()).optional(),
  sort: z.string().max(100).nullable().optional(),
  columns: z.array(z.string()).max(50).nullable().optional(),
  isShared: z.boolean().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
};
export const createViewSchema = z.object({ object: viewObject, ...viewFields }).strict();
export const updateViewSchema = z.object({ ...viewFields, name: viewFields.name.optional() }).strict();
export const listViewsSchema = z.object({ object: viewObject }).strict();

/** 400 unless filters/sort/columns are valid for the object's list endpoint. */
function validateView(object: ViewObject, view: { filters?: Record<string, unknown> | undefined; sort?: string | null | undefined; columns?: string[] | null | undefined }) {
  const spec = OBJECTS[object];
  if (view.filters !== undefined) {
    const result = spec.filters.safeParse(view.filters);
    if (!result.success) throw new ValidationError("The view's filters aren't valid for this list.", { field: "filters", ...result.error.flatten() });
  }
  if (view.sort !== undefined && view.sort !== null && !spec.sort.safeParse(view.sort).success) {
    throw new ValidationError("The view's sort isn't valid for this list.", { field: "sort" });
  }
  if (view.columns) {
    const unknown = view.columns.filter((c) => !spec.columns.includes(c));
    if (unknown.length || new Set(view.columns).size !== view.columns.length) {
      throw new ValidationError(`Unknown or repeated columns: ${unknown.join(", ") || "repeated"}.`, { field: "columns" });
    }
  }
}

const SELECT = `select id, object, name, filters, sort, columns, is_shared as "isShared", position, owner_id as "ownerId",
                       owner_id = $2 as "isMine", created_at as "createdAt", updated_at as "updatedAt"
                  from public.saved_views`;

export async function listViews(db: Queryable, actor: Actor, workspaceId: string, object: ViewObject) {
  const { rows } = await db.query(`${SELECT} where workspace_id = $1 and object = $3 and (owner_id = $2 or is_shared) order by position, created_at, id`, [
    workspaceId,
    actor.id,
    object,
  ]);
  return { data: rows };
}

export async function createView(db: Queryable, actor: Actor, workspaceId: string, input: z.infer<typeof createViewSchema>) {
  validateView(input.object, input);
  // Serialise this user's creates for the object so the limit holds under concurrency.
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`saved_views:${workspaceId}:${actor.id}:${input.object}`]);
  const count = await db.query<{ n: number }>(`select count(*)::int as n from public.saved_views where workspace_id = $1 and owner_id = $2 and object = $3`, [
    workspaceId,
    actor.id,
    input.object,
  ]);
  if (count.rows[0]!.n >= MAX_VIEWS_PER_OBJECT) throw new ConflictError(`You can save up to ${MAX_VIEWS_PER_OBJECT} views per list. Delete one first.`);
  const { rows } = await db.query<{ id: string }>(
    `insert into public.saved_views (workspace_id, owner_id, object, name, filters, sort, columns, is_shared, position)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [workspaceId, actor.id, input.object, input.name, input.filters ?? {}, input.sort ?? null, input.columns ? JSON.stringify(input.columns) : null, input.isShared ?? false, input.position ?? 0],
  );
  return getView(db, actor, workspaceId, rows[0]!.id);
}

async function getView(db: Queryable, actor: Actor, workspaceId: string, id: string) {
  const { rows } = await db.query(`${SELECT} where workspace_id = $1 and id = $3 and (owner_id = $2 or is_shared)`, [workspaceId, actor.id, id]);
  if (!rows[0]) throw new NotFoundError("Saved view");
  return rows[0] as Record<string, unknown>;
}

/** Locks a view the actor may change: their own, or (admins) a shared one. Others' private views are 404. */
async function lockEditable(db: Queryable, actor: Actor, workspaceId: string, id: string) {
  const { rows } = await db.query<{ object: ViewObject; owner_id: string | null; is_shared: boolean }>(
    `select object, owner_id, is_shared from public.saved_views where id = $1 and workspace_id = $2 for update`,
    [id, workspaceId],
  );
  const view = rows[0];
  if (!view || (view.owner_id !== actor.id && !view.is_shared)) throw new NotFoundError("Saved view");
  if (view.owner_id !== actor.id && actor.role !== "admin") throw new ForbiddenError("Only the owner or an admin can change a shared view.");
  return view;
}

export async function updateView(db: Queryable, actor: Actor, workspaceId: string, id: string, patch: z.infer<typeof updateViewSchema>) {
  const view = await lockEditable(db, actor, workspaceId, id);
  validateView(view.object, patch);
  const params: unknown[] = [id];
  const sets: string[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.filters !== undefined) set("filters", patch.filters);
  if (patch.sort !== undefined) set("sort", patch.sort);
  if (patch.columns !== undefined) set("columns", patch.columns ? JSON.stringify(patch.columns) : null);
  if (patch.isShared !== undefined) set("is_shared", patch.isShared);
  if (patch.position !== undefined) set("position", patch.position);
  if (sets.length) await db.query(`update public.saved_views set ${sets.join(", ")}, updated_at = now() where id = $1`, params);
  // No visibility check: an admin may just have un-shared someone else's view.
  return (await db.query(`${SELECT} where workspace_id = $1 and id = $3`, [workspaceId, actor.id, id])).rows[0] as Record<string, unknown>;
}

export async function deleteView(db: Queryable, actor: Actor, workspaceId: string, id: string) {
  await lockEditable(db, actor, workspaceId, id);
  await db.query(`delete from public.saved_views where id = $1`, [id]);
}
