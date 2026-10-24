/**
 * CRM v2 global search (B4): top 5 contacts, companies and deals for `q`. Escaped
 * `ilike` (trigram indexes), best trigram match first, then most recent activity.
 * Merged contacts and companies are excluded.
 */
import type { Queryable } from "../dto.js";
import { containsPattern } from "../lists/listQuery.js";

const TOP = 5;
const sim = (column: string) => `extensions.similarity(coalesce(${column}, ''), $3)`;

export async function globalSearch(db: Queryable, workspaceId: string, q: string) {
  const params = [workspaceId, containsPattern(q), q, TOP];
  const [contacts, companies, deals] = await Promise.all([
    db.query(
      `select l.id, trim(l.first_name || ' ' || l.last_name) as name, l.email, l.company, l.lifecycle_state as lifecycle
         from public.leads l
        where l.workspace_id = $1 and l.lifecycle_state <> 'merged'
          and (l.first_name ilike $2 or l.last_name ilike $2 or l.company ilike $2 or l.email ilike $2 or l.phone ilike $2)
        order by greatest(${sim("l.first_name || ' ' || l.last_name")}, ${sim("l.company")}, ${sim("l.email")}) desc, l.last_activity_at desc, l.id
        limit $4`,
      params,
    ),
    db.query(
      `select c.id, c.name, c.domain
         from public.companies c
        where c.workspace_id = $1 and c.merged_into_company_id is null and (c.name ilike $2 or c.domain ilike $2)
        order by greatest(${sim("c.name")}, ${sim("c.domain")}) desc, c.updated_at desc, c.id
        limit $4`,
      params,
    ),
    db.query(
      `select d.id, d.name, d.stage, d.amount::float8 as amount, d.currency,
              case when c.id is null then null else json_build_object('id', c.id, 'name', c.name) end as company
         from public.deals d
         left join public.companies c on c.id = d.company_id
        where d.workspace_id = $1 and (d.name ilike $2 or c.name ilike $2)
        order by greatest(${sim("d.name")}, ${sim("c.name")}) desc, d.updated_at desc, d.id
        limit $4`,
      params,
    ),
  ]);
  return { contacts: contacts.rows, companies: companies.rows, deals: deals.rows };
}
