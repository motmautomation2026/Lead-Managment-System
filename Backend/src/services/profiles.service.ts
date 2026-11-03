import { z } from "zod";
import type { Queryable } from "../dto.js";

/** Active CRM users (salespeople and admins): the owner pickers' directory. */
export async function listProfiles(db: Queryable) {
  const result = await db.query<{ id: string; full_name: string; email: string; initials: string; role: "admin" | "salesperson" }>(
    `select id, full_name, email, initials, role
       from public.profiles
      where is_active
      order by full_name asc`,
  );
  return result.rows.map((r) => ({ id: r.id, name: r.full_name, email: r.email, initials: r.initials, active: true, role: r.role }));
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
