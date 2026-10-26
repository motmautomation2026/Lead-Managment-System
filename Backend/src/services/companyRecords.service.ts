/**
 * CRM v2 companies API (B4): list (list standard), count, detail, manual create and
 * edit. Linking contacts and merging stay in companies.service.ts. A rename keeps
 * every linked contact's `leads.company` text equal to the company name (design §1.2).
 */
import { z } from "zod";
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { FREE_MAIL_DOMAINS, isPlaceholderCompany, normalizeCompanyName, normalizeDomain } from "../domain/companyNormalize.js";
import { parseRevenueRange } from "../domain/revenue.js";
import {
  addOwnerFilter,
  addRange,
  containsPattern,
  defineSorts,
  isoTimestamp,
  multi,
  ownerIdFilter,
  pageParams,
  runCount,
  runPage,
  searchQuery,
  sortParam,
  SqlBuilder,
  strictBoolean,
} from "../lists/listQuery.js";
import { getProfile } from "./profiles.service.js";
import { openSimilarNameCandidates } from "./companies.service.js";

export const COMPANY_SORTS = defineSorts({
  idColumn: "c.id",
  defaultSort: "name:asc",
  fields: {
    name: { columns: ["c.name"], type: "text" },
    createdAt: { columns: ["c.created_at"], type: "timestamptz" },
    updatedAt: { columns: ["c.updated_at"], type: "timestamptz" },
    // Computed per row (no index possible); fine at today's sizes, see docs/crm-v2/B4-api.md.
    contactCount: { columns: ["cc.contact_count"], type: "int" },
  },
});

export const companyFilterSchema = z
  .object({
    ownerId: ownerIdFilter.optional(),
    industry: multi(z.string().trim().min(1).max(200)).optional(),
    hasDomain: strictBoolean.optional(),
    createdFrom: isoTimestamp.optional(),
    createdTo: isoTimestamp.optional(),
    q: searchQuery.optional(),
  })
  .strict();
export const companySortSchema = sortParam(COMPANY_SORTS);
export const companyListSchema = companyFilterSchema.extend({ ...pageParams, sort: companySortSchema }).strict();
export type CompanyFilters = z.infer<typeof companyFilterSchema>;

export const COMPANY_COLUMNS = ["name", "domain", "industry", "city", "owner", "contactCount", "openDealCount", "openDealAmount", "createdAt", "updatedAt"] as const;

// Contacts exclude merged ones; open deal amounts are INR only (the only currency for now).
const COUNTS = `
  cross join lateral (
    select count(*)::int as contact_count, max(l.last_activity_at) as last_activity_at from public.leads l
     where l.workspace_id = c.workspace_id and l.company_id = c.id and l.lifecycle_state <> 'merged') cc
  cross join lateral (
    select count(*)::int as open_deal_count, coalesce(sum(d.amount) filter (where d.currency = 'INR'), 0)::float8 as open_deal_amount
      from public.deals d where d.company_id = c.id and d.stage not in ('won', 'lost')) dd`;
const OWNER_JSON = `case when o.id is null then null else json_build_object('id', o.id, 'name', o.full_name) end`;

function companyWhere(workspaceId: string, actor: Actor, f: CompanyFilters): SqlBuilder {
  const b = new SqlBuilder();
  b.and(`c.workspace_id = ${b.p(workspaceId)}`).and(`c.merged_into_company_id is null`);
  addOwnerFilter(b, "c.owner_id", f.ownerId, actor.id);
  if (f.industry) b.and(`c.industry = any(${b.p(f.industry)}::text[])`);
  if (f.hasDomain !== undefined) b.and(`c.domain is ${f.hasDomain ? "not " : ""}null`);
  addRange(b, "c.created_at", f.createdFrom, f.createdTo, "timestamptz");
  if (f.q) {
    const q = b.p(containsPattern(f.q));
    b.and(`(c.name ilike ${q} or c.domain ilike ${q})`);
  }
  return b;
}

export function listCompanies(db: Queryable, actor: Actor, workspaceId: string, query: z.infer<typeof companyListSchema>) {
  return runPage(db, companyWhere(workspaceId, actor, query), query.sort, query, ({ where, orderBy, limit, cursorSelect }) =>
    `select c.id, c.name, c.domain, c.industry, c.city, ${OWNER_JSON} as owner,
            cc.contact_count as "contactCount", dd.open_deal_count as "openDealCount", dd.open_deal_amount as "openDealAmount",
            c.created_at as "createdAt", c.updated_at as "updatedAt", ${cursorSelect}
       from public.companies c
       left join public.profiles o on o.id = c.owner_id
       ${COUNTS}
      ${where}
      order by ${orderBy}
      limit ${limit}`,
  );
}

export const countCompanies = (db: Queryable, actor: Actor, workspaceId: string, filters: CompanyFilters) =>
  runCount(db, companyWhere(workspaceId, actor, filters), "public.companies c");

/** Up to 200 distinct industry values of live companies, A–Z. */
export async function listIndustries(db: Queryable, workspaceId: string): Promise<string[]> {
  const { rows } = await db.query<{ industry: string }>(
    `select distinct industry from public.companies
      where workspace_id = $1 and merged_into_company_id is null and industry is not null and industry <> ''
      order by industry limit 200`,
    [workspaceId],
  );
  return rows.map((r) => r.industry);
}

const DETAIL_SELECT = `
  select c.id, c.name, c.domain, c.website, c.industry, c.revenue_range as "revenueRange",
         c.revenue_min_cr::float8 as "revenueMinCr", c.revenue_max_cr::float8 as "revenueMaxCr",
         c.city, c.state, c.country, c.linkedin_url as "linkedinUrl", c.employee_range as "employeeRange",
         c.description, ${OWNER_JSON} as owner, c.merged_into_company_id as "mergedIntoCompanyId",
         c.created_by_name as "createdBy", c.created_at as "createdAt", c.updated_at as "updatedAt",
         cc.contact_count as "contactCount", dd.open_deal_count as "openDealCount", dd.open_deal_amount as "openDealAmount",
         cc.last_activity_at as "lastActivityAt"
    from public.companies c
    left join public.profiles o on o.id = c.owner_id
    ${COUNTS}
   where c.id = $1 and c.workspace_id = $2`;

/** All fields + counts + the latest activity across its contacts. A merged company is still returned (with mergedIntoCompanyId) so old links can follow it. */
export async function getCompany(db: Queryable, workspaceId: string, id: string) {
  const { rows } = await db.query(DETAIL_SELECT, [id, workspaceId]);
  if (!rows[0]) throw new NotFoundError("Company");
  return rows[0] as Record<string, unknown> & { id: string; name: string };
}

/** 404 unless the company is in this workspace and not merged away. */
export async function assertCompanyUsable(db: Queryable, workspaceId: string, id: string) {
  const { rows } = await db.query<{ merged: boolean }>(
    `select merged_into_company_id is not null as merged from public.companies where id = $1 and workspace_id = $2`,
    [id, workspaceId],
  );
  if (!rows[0] || rows[0].merged) throw new NotFoundError("Company");
}

const text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === "" ? null : v));
const companyFields = {
  domain: text(253),
  website: text(500),
  industry: text(200),
  revenueRange: text(200),
  city: text(200),
  state: text(200),
  country: text(200),
  linkedinUrl: text(500),
  employeeRange: text(100),
  description: text(5000),
  ownerId: z.string().uuid().nullable().optional(),
};
export const createCompanySchema = z.object({ name: z.string().trim().min(1).max(300), ...companyFields }).strict();
export const updateCompanySchema = z.object({ name: z.string().trim().min(1).max(300).optional(), ...companyFields }).strict();
type CompanyInput = z.infer<typeof updateCompanySchema>;

const COLUMN: Record<Exclude<keyof CompanyInput, "name" | "domain" | "revenueRange" | "ownerId">, string> = {
  website: "website",
  industry: "industry",
  city: "city",
  state: "state",
  country: "country",
  linkedinUrl: "linkedin_url",
  employeeRange: "employee_range",
  description: "description",
};

function checkName(name: string): string {
  if (isPlaceholderCompany(name)) throw new ValidationError(`"${name}" isn't a company name.`, { field: "name" });
  return normalizeCompanyName(name);
}

function checkDomain(input: string | null): string | null {
  if (input === null) return null;
  const domain = normalizeDomain(input);
  if (!domain) throw new ValidationError("The domain isn't valid. Use a domain like example.com.", { field: "domain" });
  if (FREE_MAIL_DOMAINS.includes(domain)) throw new ValidationError("A free-mail domain can't be a company domain.", { field: "domain" });
  return domain;
}

async function checkOwner(db: Queryable, ownerId: string | null | undefined) {
  if (!ownerId) return;
  const owner = await getProfile(db, ownerId);
  if (!owner?.active) throw new ValidationError("The owner must be an active user.", { field: "ownerId" });
}

/** 409 with the existing company's id when another live company has this normalized name or domain. */
async function assertNoDuplicate(db: Queryable, workspaceId: string, exceptId: string | null, normalizedName: string | null, domain: string | null) {
  const { rows } = await db.query<{ id: string; name: string; same_name: boolean }>(
    `select id, name, normalized_name = $3 as same_name from public.companies
      where workspace_id = $1 and merged_into_company_id is null and id is distinct from $2::uuid
        and (normalized_name = $3 or domain = $4)
      order by (normalized_name = $3) desc limit 1`,
    [workspaceId, exceptId, normalizedName, domain],
  );
  const hit = rows[0];
  if (hit) {
    throw new ConflictError(hit.same_name ? `A company named "${hit.name}" already exists.` : `"${hit.name}" already uses this domain.`, {
      companyId: hit.id,
    });
  }
}

/** Manual create through the same normaliser and unique rules as automatic linking. */
export async function createCompany(db: Queryable, actor: Actor, workspaceId: string, input: z.infer<typeof createCompanySchema>) {
  const normalizedName = checkName(input.name);
  const domain = checkDomain(input.domain ?? null);
  await checkOwner(db, input.ownerId);
  await assertNoDuplicate(db, workspaceId, null, normalizedName, domain);
  const revenue = parseRevenueRange(input.revenueRange);
  const { rows } = await db.query<{ id: string }>(
    `insert into public.companies
       (workspace_id, name, normalized_name, domain, website, industry, revenue_range, revenue_min_cr, revenue_max_cr,
        city, state, country, linkedin_url, employee_range, description, owner_id, created_by, created_by_name)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
    [
      workspaceId, input.name, normalizedName, domain, input.website ?? null, input.industry ?? null, input.revenueRange ?? null,
      revenue?.minCr ?? null, revenue?.maxCr ?? null, input.city ?? null, input.state ?? null, input.country ?? null,
      input.linkedinUrl ?? null, input.employeeRange ?? null, input.description ?? null,
      input.ownerId === undefined ? actor.id : input.ownerId, actor.id, actor.fullName,
    ],
  );
  const id = rows[0]!.id;
  await openSimilarNameCandidates(db, workspaceId, id, normalizedName);
  return getCompany(db, workspaceId, id);
}

/** Edits a live company. A rename re-normalizes and syncs the linked contacts' company text in the same transaction. */
export async function updateCompany(db: Queryable, workspaceId: string, id: string, patch: CompanyInput) {
  const current = (
    await db.query<{ name: string; normalized_name: string; merged_into_company_id: string | null }>(
      `select name, normalized_name, merged_into_company_id from public.companies where id = $1 and workspace_id = $2 for update`,
      [id, workspaceId],
    )
  ).rows[0];
  if (!current) throw new NotFoundError("Company");
  if (current.merged_into_company_id) throw new ConflictError("This company was merged into another one; edit that company instead.");

  const b = new SqlBuilder();
  const sets: string[] = [];
  const set = (column: string, value: unknown) => sets.push(`${column} = ${b.p(value)}`);
  const renamed = patch.name !== undefined && patch.name !== current.name;
  const normalizedName = renamed ? checkName(patch.name!) : null;
  const domain = patch.domain === undefined ? undefined : checkDomain(patch.domain);
  if (normalizedName !== null || domain) await assertNoDuplicate(db, workspaceId, id, normalizedName, domain ?? null);
  if (patch.ownerId !== undefined) await checkOwner(db, patch.ownerId);

  if (renamed) {
    set("name", patch.name);
    set("normalized_name", normalizedName);
  }
  if (domain !== undefined) set("domain", domain);
  if (patch.revenueRange !== undefined) {
    const revenue = parseRevenueRange(patch.revenueRange);
    set("revenue_range", patch.revenueRange);
    set("revenue_min_cr", revenue?.minCr ?? null);
    set("revenue_max_cr", revenue?.maxCr ?? null);
  }
  for (const [key, column] of Object.entries(COLUMN) as [keyof typeof COLUMN, string][]) {
    if (patch[key] !== undefined) set(column, patch[key]);
  }
  if (patch.ownerId !== undefined) set("owner_id", patch.ownerId);

  if (sets.length) await db.query(`update public.companies set ${sets.join(", ")} where id = ${b.p(id)}`, b.params);
  if (renamed) {
    await db.query(`update public.leads set company = $3 where workspace_id = $1 and company_id = $2`, [workspaceId, id, patch.name]);
  }
  return getCompany(db, workspaceId, id);
}
