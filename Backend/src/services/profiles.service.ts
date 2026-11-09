import { z } from "zod";
import type { Queryable } from "../dto.js";
import { ValidationError } from "../errors.js";

/**
 * The owner pickers' directory for one workspace (E4b rule 5): its active members with their role there
 * (`member: true`, the only ones a picker offers), plus active non-members who still own contacts,
 * companies, deals, tasks or meetings there (`member: false`, shown "(not in this workspace)").
 */
export async function listProfiles(db: Queryable, workspaceId: string) {
  const result = await db.query<{ id: string; full_name: string; email: string; initials: string; role: "admin" | "salesperson" | null }>(
    `with owners as (
       select owner_id from public.leads where workspace_id = $1 and owner_id is not null
       union select owner_id from public.companies where workspace_id = $1 and owner_id is not null
       union select owner_id from public.deals where workspace_id = $1 and owner_id is not null
       union select owner_id from public.tasks where workspace_id = $1 and owner_id is not null
       union select owner_id from public.meetings where workspace_id = $1 and owner_id is not null
     )
     select p.id, p.full_name, p.email, p.initials, m.role
       from public.profiles p
       left join public.workspace_members m on m.user_id = p.id and m.workspace_id = $1
      where p.is_active and (m.user_id is not null or p.id in (select owner_id from owners))
      order by p.full_name asc`,
    [workspaceId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    name: r.full_name,
    email: r.email,
    initials: r.initials,
    active: true,
    role: r.role ?? "salesperson",
    member: r.role !== null,
  }));
}

/**
 * E4b rule 5: a new owner / assignee must be an active member of the workspace. Every assignment path
 * (contacts, bulk assign, companies, deals, tasks, meetings, revenue rules, website owner, number owner)
 * calls this; existing data owned by a non-member stays as it is.
 */
export async function assertAssignableUser(db: Queryable, workspaceId: string, userId: string, field = "ownerId"): Promise<{ id: string; name: string }> {
  const result = await db.query<{ id: string; full_name: string }>(
    `select p.id, p.full_name from public.profiles p
       join public.workspace_members m on m.user_id = p.id and m.workspace_id = $1
      where p.id = $2 and p.is_active`,
    [workspaceId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationError("The owner must be an active member of this workspace.", { field });
  return { id: row.id, name: row.full_name };
}

export async function getProfile(db: Queryable, id: string) {
  const result = await db.query<{ id: string; full_name: string; email: string; initials: string; is_active: boolean }>(
    `select id, full_name, email, initials, is_active from public.profiles where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, name: row.full_name, email: row.email, initials: row.initials, active: row.is_active };
}

/**
 * E3b-1 rule 5: a user's own booking page (Calendly, Google booking…), https only, ≤ 300 characters
 * (migration 049). Blank → null (removed).
 */
export const bookingUrlSchema = z
  .string()
  .trim()
  .max(300, "The booking link can be at most 300 characters.")
  .transform((value) => value || null)
  .refine((value) => value === null || isHttpsUrl(value), "Use a full https:// link, e.g. https://calendly.com/your-name.")
  .nullable();

function isHttpsUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.includes(".");
  } catch {
    return false;
  }
}

export async function getBookingUrl(db: Queryable, id: string): Promise<string | null> {
  return (await db.query<{ booking_url: string | null }>(`select booking_url from public.profiles where id = $1`, [id])).rows[0]?.booking_url ?? null;
}

export async function setBookingUrl(db: Queryable, id: string, bookingUrl: string | null): Promise<void> {
  await db.query(`update public.profiles set booking_url = $2 where id = $1`, [id, bookingUrl]);
}
