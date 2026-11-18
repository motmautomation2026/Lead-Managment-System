/**
 * UX-1: the full email / WhatsApp safety-event history for Settings → Monitoring, newest first, as keyset pages
 * (the settings payloads keep only the latest 20). Every CRM user may read them, like the settings.
 * Served by the (workspace_id, created_at desc) indexes from 041 / 042; ties on created_at are broken by id.
 */
import { z } from "zod";
import { pool } from "../db.js";
import type { Queryable } from "../dto.js";
import { defineSorts, pageParams, runPage, SqlBuilder, sortParam } from "../lists/listQuery.js";

const EVENT_SORTS = defineSorts({
  fields: { createdAt: { columns: ["e.created_at"], type: "timestamptz" } },
  idColumn: "e.id",
  defaultSort: "createdAt:desc",
});
export const safetyEventListSchema = z.object({ ...pageParams, sort: sortParam(EVENT_SORTS) }).strict();
type Query = z.infer<typeof safetyEventListSchema>;

interface EventRow {
  id: string;
  kind: string;
  detail: string | null;
  at: Date;
  numberLabel?: string | null;
}
const toJson = ({ at, ...row }: EventRow) => ({ ...row, at: at.toISOString() });

export async function listEmailSafetyEvents(workspaceId: string, query: Query, db: Queryable = pool) {
  const b = new SqlBuilder();
  b.and(`e.workspace_id = ${b.p(workspaceId)}`);
  const page = await runPage<EventRow>(
    db,
    b,
    query.sort,
    query,
    ({ where, orderBy, limit, cursorSelect }) =>
      `select e.id, e.kind, e.detail, e.created_at as at, ${cursorSelect}
         from public.email_safety_events e ${where} order by ${orderBy} limit ${limit}`,
  );
  return { data: page.data.map(toJson), nextCursor: page.nextCursor };
}

export async function listWhatsAppSafetyEvents(workspaceId: string, query: Query, db: Queryable = pool) {
  const b = new SqlBuilder();
  b.and(`e.workspace_id = ${b.p(workspaceId)}`);
  const page = await runPage<EventRow>(
    db,
    b,
    query.sort,
    query,
    ({ where, orderBy, limit, cursorSelect }) =>
      `select e.id, e.kind, e.detail, e.created_at as at, n.label as "numberLabel", ${cursorSelect}
         from public.whatsapp_safety_events e
         left join public.whatsapp_numbers n on n.id = e.whatsapp_number_id and n.workspace_id = e.workspace_id
         ${where} order by ${orderBy} limit ${limit}`,
  );
  return { data: page.data.map(toJson), nextCursor: page.nextCursor };
}
