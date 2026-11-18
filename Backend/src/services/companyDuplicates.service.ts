/**
 * CRM v2 duplicate review (B4, admin only): company PAIR suggestions (merge or dismiss)
 * and contact-level rows (a contact whose company text/domain disagrees with its
 * company: relink or dismiss). Merging goes through mergeCompanies.
 */
import { z } from "zod";
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { defineSorts, multi, pageParams, runCount, runPage, sortParam, SqlBuilder } from "../lists/listQuery.js";
import { mergeCompanies } from "./companies.service.js";
import { assertCompanyUsable, createCompany } from "./companyRecords.service.js";
import { addTimelineEvent, actorEvent } from "./timeline.service.js";

export const DUPLICATE_SORTS = defineSorts({
  idColumn: "x.id",
  defaultSort: "createdAt:desc",
  fields: { createdAt: { columns: ["x.created_at"], type: "timestamptz" } },
});

export const duplicateFilterSchema = z
  .object({
    status: multi(z.enum(["open", "merged", "dismissed", "all"])).optional(),
    reason: multi(z.enum(["similar_name", "same_domain_different_name", "name_domain_conflict"])).optional(),
    kind: z.enum(["pair", "contact"]).optional(),
    companyId: z.string().uuid().optional(),
  })
  .strict();
export const duplicateListSchema = duplicateFilterSchema.extend({ ...pageParams, sort: sortParam(DUPLICATE_SORTS) }).strict();
type DuplicateFilters = z.infer<typeof duplicateFilterSchema>;

const COMPANY_JSON = (alias: string) => `
  case when ${alias}.id is null then null else json_build_object(
    'id', ${alias}.id, 'name', ${alias}.name, 'domain', ${alias}.domain, 'industry', ${alias}.industry,
    'merged', ${alias}.merged_into_company_id is not null,
    'openDealCount', (select count(*)::int from public.deals d where d.company_id = ${alias}.id and d.stage not in ('won', 'lost')),
    'contactCount', (select count(*)::int from public.leads l
                      where l.workspace_id = ${alias}.workspace_id and l.company_id = ${alias}.id and l.lifecycle_state <> 'merged')) end`;

function duplicateWhere(workspaceId: string, f: DuplicateFilters): SqlBuilder {
  const b = new SqlBuilder();
  b.and(`x.workspace_id = ${b.p(workspaceId)}`);
  const status = f.status ?? ["open"];
  if (!status.includes("all")) b.and(`x.status = any(${b.p(status)}::text[])`);
  if (f.reason) b.and(`x.reason = any(${b.p(f.reason)}::text[])`);
  if (f.kind) b.and(`x.company_b_id is ${f.kind === "pair" ? "not " : ""}null`);
  if (f.companyId) {
    const id = b.p(f.companyId);
    b.and(`(x.company_a_id = ${id} or x.company_b_id = ${id})`);
  }
  return b;
}

/** Open rows by default; both pair and contact-level rows, with what the review screen shows. */
export function listDuplicates(db: Queryable, workspaceId: string, query: z.infer<typeof duplicateListSchema>) {
  const b = duplicateWhere(workspaceId, query);
  return runPage(db, b, query.sort, query, ({ where, orderBy, limit, cursorSelect }) =>
    `select x.id, case when x.company_b_id is null then 'contact' else 'pair' end as kind, x.reason, x.score::float8 as score,
            x.status, x.created_at as "createdAt", x.resolved_at as "resolvedAt",
            ${COMPANY_JSON("a")} as "companyA", ${COMPANY_JSON("bb")} as "companyB",
            case when l.id is null then null else json_build_object(
              'id', l.id, 'name', trim(l.first_name || ' ' || l.last_name), 'email', l.email, 'company', l.company) end as contact,
            x.observed_name as "observedName", x.observed_domain as "observedDomain", ${cursorSelect}
       from public.company_duplicate_candidates x
       join public.companies a on a.id = x.company_a_id
       left join public.companies bb on bb.id = x.company_b_id
       left join public.leads l on l.id = x.lead_id
      ${where}
      order by ${orderBy}
      limit ${limit}`,
  );
}

/** Same filters as the list (the review button, per-kind counts and the nav badge). */
export const countDuplicates = (db: Queryable, workspaceId: string, filters: DuplicateFilters) =>
  runCount(db, duplicateWhere(workspaceId, filters), "public.company_duplicate_candidates x");

interface CandidateRow {
  id: string;
  company_a_id: string;
  company_b_id: string | null;
  lead_id: string | null;
  observed_name: string | null;
  status: string;
}

async function lockOpenCandidate(db: Queryable, workspaceId: string, id: string): Promise<CandidateRow> {
  const { rows } = await db.query<CandidateRow>(
    `select id, company_a_id, company_b_id, lead_id, observed_name, status from public.company_duplicate_candidates
      where id = $1 and workspace_id = $2 for update`,
    [id, workspaceId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Duplicate suggestion");
  if (row.status !== "open") throw new ConflictError(`This suggestion was already ${row.status}.`);
  return row;
}

const resolve = (db: Queryable, actor: Actor, id: string, status: "merged" | "dismissed") =>
  db.query(`update public.company_duplicate_candidates set status = $2, resolved_by = $3, resolved_at = now() where id = $1 and status = 'open'`, [
    id,
    status,
    actor.id,
  ]);

/** Pair rows only: merges the other company into `targetId` (default company A). mergeCompanies marks the row merged. */
export async function mergeDuplicate(db: Queryable, actor: Actor, workspaceId: string, id: string, targetId?: string) {
  const row = await lockOpenCandidate(db, workspaceId, id);
  if (!row.company_b_id) throw new ValidationError("This suggestion is about one contact; relink or dismiss it.");
  const target = targetId ?? row.company_a_id;
  if (target !== row.company_a_id && target !== row.company_b_id) throw new ValidationError("Keep one of the two suggested companies.", { field: "targetId" });
  const source = target === row.company_a_id ? row.company_b_id : row.company_a_id;
  return mergeCompanies(db, actor, workspaceId, target, source);
}

export async function dismissDuplicate(db: Queryable, actor: Actor, workspaceId: string, id: string) {
  await lockOpenCandidate(db, workspaceId, id);
  await resolve(db, actor, id, "dismissed");
}

/**
 * Contact-level rows only: links the contact to `companyId`, or to a NEW company named
 * after the observed text (same normaliser/unique rules as POST /companies; a clash is a
 * 409 with the existing id; no domain, which belongs to the company it was matched to).
 * The row is resolved as dismissed (the suggestion is handled; nothing was merged).
 */
export async function relinkDuplicate(db: Queryable, actor: Actor, workspaceId: string, id: string, companyId?: string) {
  const row = await lockOpenCandidate(db, workspaceId, id);
  if (row.company_b_id || !row.lead_id) throw new ValidationError("Only a suggestion about one contact can be relinked; merge or dismiss a company pair.");
  let target: { id: string; name: string };
  if (companyId) {
    await assertCompanyUsable(db, workspaceId, companyId);
    target = (await db.query<{ id: string; name: string }>(`select id, name from public.companies where id = $1`, [companyId])).rows[0]!;
  } else {
    if (!row.observed_name) throw new ValidationError("This suggestion has no company name to create; choose a company.");
    target = await createCompany(db, actor, workspaceId, { name: row.observed_name, domain: null });
  }
  const lead = await db.query<{ company_id: string | null }>(
    `update public.leads set company_id = $2, company = $3, company_link_checked_at = now() where id = $1 and workspace_id = $4 returning company_id`,
    [row.lead_id, target.id, target.name, workspaceId],
  );
  if (!lead.rows[0]) throw new NotFoundError("Contact");
  await addTimelineEvent(db, { leadId: row.lead_id, kind: "system", title: "Company changed", detail: `Linked to ${target.name}.`, ...actorEvent(actor), metadata: { companyId: target.id } });
  await resolve(db, actor, id, "dismissed");
  return { leadId: row.lead_id, companyId: target.id };
}
