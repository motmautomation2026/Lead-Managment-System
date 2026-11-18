import type { Actor } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { NotFoundError } from "../errors.js";
import { recordAdminAudit } from "./admin-audit.service.js";
import { assertAssignableUser } from "./profiles.service.js";

export interface WebsiteLeadSettings {
  defaultOwnerId: string | null;
  defaultOwnerName: string | null;
  /** False when an owner is saved but is no longer an active member of the workspace (E4b); new website leads then stay unassigned. */
  ownerAvailable: boolean;
}

export async function getWebsiteLeadSettings(workspaceId: string, db: Queryable = pool): Promise<WebsiteLeadSettings> {
  const result = await db.query<{ owner_id: string | null; full_name: string | null; usable: boolean | null }>(
    `select w.default_lead_owner_id as owner_id,
            p.full_name,
            p.is_active and exists (select 1 from public.workspace_members m where m.workspace_id = w.id and m.user_id = p.id) as usable
       from public.workspaces w
       left join public.profiles p on p.id = w.default_lead_owner_id
      where w.id = $1`,
    [workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Workspace");
  return {
    defaultOwnerId: row.owner_id,
    defaultOwnerName: row.full_name,
    ownerAvailable: row.owner_id === null ? true : Boolean(row.usable),
  };
}

/** Only an active member of the workspace (E4b) may own website leads; null clears the setting (leads become unassigned). */
export async function updateWebsiteLeadSettings(actor: Actor, workspaceId: string, input: { defaultOwnerId: string | null }) {
  await withTransaction(async (db) => {
    if (input.defaultOwnerId) await assertAssignableUser(db, workspaceId, input.defaultOwnerId, "defaultOwnerId");
    const updated = await db.query(`update public.workspaces set default_lead_owner_id = $2 where id = $1`, [workspaceId, input.defaultOwnerId]);
    if (!updated.rowCount) throw new NotFoundError("Workspace");
    await recordAdminAudit(db, actor, "workspace.default_lead_owner_changed", "workspace", workspaceId, { defaultOwnerId: input.defaultOwnerId });
  });
  return getWebsiteLeadSettings(workspaceId);
}
