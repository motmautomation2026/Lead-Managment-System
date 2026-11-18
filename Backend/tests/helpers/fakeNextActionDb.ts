/**
 * LL-1: a fake Queryable for the safety-net services (no database). Answers the responsible-person
 * query, createTask's lead check and inserts, and records every insert so tests can assert on them.
 */
import type { Queryable } from "../../src/dto.js";

export interface FakeLeadState {
  ownerId: string | null;
  ownerName?: string | null;
  ownerActive?: boolean;
  ownerMember?: boolean;
  adminIds?: string[];
  /** Rows for other selects, by a substring of the SQL. */
  extra?: { match: string; rows: unknown[] }[];
}

export function fakeNextActionDb(state: FakeLeadState) {
  const tasks: { owner_id: string | null; title: string; task_type: string; origin: string; due_at: string }[] = [];
  const bells: { workspaceId: string; recipients: string[]; title: string; href: string | null; leadId: string | null }[] = [];
  const timeline: { title: string; detail: string | null }[] = [];
  const updates: string[] = [];
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const extra = state.extra?.find((e) => sql.includes(e.match));
      if (extra) return { rows: extra.rows, rowCount: extra.rows.length };
      if (sql.includes("as admin_ids")) {
        return {
          rows: [
            {
              owner_id: state.ownerId,
              owner_name: state.ownerName ?? "Owner",
              owner_active: state.ownerActive ?? true,
              owner_member: state.ownerMember ?? true,
              admin_ids: state.adminIds ?? ["admin-1"],
            },
          ],
        };
      }
      if (sql.startsWith("select id from public.leads where id = $1 and workspace_id = $2")) return { rows: [{ id: params[0] }], rowCount: 1 };
      if (sql.includes("insert into public.tasks")) {
        const row = {
          id: `task-${tasks.length + 1}`,
          lead_id: params[1],
          owner_id: params[2] as string | null,
          owner_name: params[3],
          task_type: params[4] as string,
          title: params[5] as string,
          due_at: params[6] as string,
          origin: params[7] as string,
          status: "open",
        };
        tasks.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("insert into public.timeline_events")) {
        timeline.push({ title: params[3] as string, detail: (params[4] as string | null) ?? null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into public.notifications")) {
        if (sql.includes("unnest($2::uuid[])")) {
          bells.push({ workspaceId: params[0] as string, recipients: params[1] as string[], title: params[2] as string, leadId: params[5] as string | null, href: params[6] as string | null });
        } else {
          bells.push({ workspaceId: params[0] as string, recipients: [params[1] as string], title: params[2] as string, leadId: null, href: null });
        }
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*(update|delete)/i.test(sql)) {
        updates.push(sql);
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*select/i.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${sql.slice(0, 120)}`);
    },
  } as unknown as Queryable;
  return { db, tasks, bells, timeline, updates, queries };
}
