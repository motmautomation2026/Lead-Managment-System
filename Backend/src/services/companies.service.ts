import type { Queryable } from "../dto.js";
import { pool } from "../db.js";
import type { Actor } from "../authMiddleware.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { companyMatch, SIMILAR_NAME_THRESHOLD, type CompanyMatch, type CompanyRef, type MatchCandidate } from "../domain/companyMatch.js";
import { corporateDomain, isPlaceholderCompany, normalizeCompanyName } from "../domain/companyNormalize.js";
import { addTimelineEvent, actorEvent } from "./timeline.service.js";
import { fairPickSql } from "./fairPick.js";

/**
 * CRM v2 companies (B2-design §2.1). A contact is a `leads` row; `leads.company_id`
 * links it to one company and `leads.company` (the text templates and the AI read)
 * is kept equal to the company name. Contact dedupe is not touched here.
 */

const SIMILAR_NAME_LIMIT = 3;
export const MAX_COMPANY_LINK_ATTEMPTS = 3;

interface LinkLeadRow {
  id: string;
  company: string;
  email: string | null;
  industry: string | null;
  revenue_range: string | null;
  revenue_min_cr: string | null;
  revenue_max_cr: string | null;
  owner_id: string | null;
}

export type CompanyLinkResult = { action: CompanyMatch["action"]; companyId: string | null };

async function findCompanies(db: Queryable, workspaceId: string, normalizedName: string, domain: string | null) {
  const { rows } = await db.query<CompanyRef & { normalized_name: string; similarity: number }>(
    `select id, domain, normalized_name, extensions.similarity(normalized_name, $2)::float8 as similarity from public.companies
      where workspace_id = $1 and merged_into_company_id is null
        and (normalized_name = $2 or ($3::text is not null and domain = $3::text))`,
    [workspaceId, normalizedName, domain],
  );
  const byName = rows.find((r) => r.normalized_name === normalizedName);
  const byDomain = domain ? rows.find((r) => r.domain === domain) : undefined;
  return {
    byName: byName ? { id: byName.id, domain: byName.domain } : null,
    byDomain: byDomain ? { id: byDomain.id, domain: byDomain.domain, similarity: byDomain.similarity } : null,
  };
}

/** Returns the new id, or null when a concurrent transaction created the same name/domain first. */
async function insertCompany(db: Queryable, workspaceId: string, lead: LinkLeadRow, normalizedName: string, domain: string | null) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.companies
       (workspace_id, name, normalized_name, domain, industry, revenue_range, revenue_min_cr, revenue_max_cr, owner_id, created_by_name)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'System')
     on conflict do nothing
     returning id`,
    [workspaceId, lead.company.trim(), normalizedName, domain, lead.industry, lead.revenue_range, lead.revenue_min_cr, lead.revenue_max_cr, lead.owner_id],
  );
  return rows[0]?.id ?? null;
}

async function openCandidates(db: Queryable, workspaceId: string, companyId: string, lead: LinkLeadRow, domain: string | null, candidates: MatchCandidate[]) {
  for (const candidate of candidates) {
    if (candidate.otherCompanyId) {
      const [a, b] = [companyId, candidate.otherCompanyId].sort();
      await db.query(
        `insert into public.company_duplicate_candidates (workspace_id, company_a_id, company_b_id, reason)
         values ($1,$2,$3,$4) on conflict do nothing`,
        [workspaceId, a, b, candidate.reason],
      );
    } else {
      await db.query(
        `insert into public.company_duplicate_candidates (workspace_id, company_a_id, lead_id, observed_name, observed_domain, reason)
         values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
        [workspaceId, companyId, lead.id, lead.company.trim(), domain, candidate.reason],
      );
    }
  }
}

/**
 * Step 6: after a create, pair the new company with up to 3 existing ones whose names look alike.
 * The `%` operator (default threshold 0.3) lets the trigram index on normalized_name find
 * candidates; the 0.6 cut is applied to their similarity().
 */
export async function openSimilarNameCandidates(db: Queryable, workspaceId: string, companyId: string, normalizedName: string) {
  await db.query(
    `insert into public.company_duplicate_candidates (workspace_id, company_a_id, company_b_id, reason, score)
     select $1, least($2::uuid, c.id), greatest($2::uuid, c.id), 'similar_name', round(c.score::numeric, 4)
       from (select id, extensions.similarity(normalized_name, $3) as score
               from public.companies
              where normalized_name operator(extensions.%) $3
                and workspace_id = $1 and merged_into_company_id is null and id <> $2) c
      where c.score >= $4
      order by c.score desc
      limit $5
     on conflict do nothing`,
    [workspaceId, companyId, normalizedName, SIMILAR_NAME_THRESHOLD, SIMILAR_NAME_LIMIT],
  );
}

/**
 * Links (or creates, or unlinks) the lead's company and marks the lead checked.
 * Runs in the caller's transaction and may throw: callers use linkCompanySafely.
 * Concurrency: INSERT ... ON CONFLICT DO NOTHING on the unique (workspace, name)
 * and (workspace, domain) indexes waits for a concurrent creator to commit; if it
 * won, the lookup is repeated once and the lead links to its company.
 */
export async function linkCompanyForLead(db: Queryable, workspaceId: string, leadId: string): Promise<CompanyLinkResult> {
  const lead = (
    await db.query<LinkLeadRow>(
      `select id, company, email, industry, revenue_range, revenue_min_cr, revenue_max_cr, owner_id
         from public.leads where id = $1 and workspace_id = $2`,
      [leadId, workspaceId],
    )
  ).rows[0];
  if (!lead) throw new NotFoundError("Lead");

  if (isPlaceholderCompany(lead.company)) {
    await db.query(`update public.leads set company_id = null, company_link_checked_at = now() where id = $1`, [leadId]);
    return { action: "none", companyId: null };
  }

  const normalizedName = normalizeCompanyName(lead.company);
  const domain = corporateDomain(lead.email);
  for (let attempt = 0; attempt < 2; attempt++) {
    const found = await findCompanies(db, workspaceId, normalizedName, domain);
    const match = companyMatch({ companyText: lead.company, email: lead.email, ...found });

    let companyId: string;
    if (match.action === "link") {
      companyId = match.companyId;
    } else if (match.action === "create") {
      const created = await insertCompany(db, workspaceId, lead, match.normalizedName, match.domain);
      if (!created) continue; // lost the race: look again
      companyId = created;
    } else {
      throw new Error("unreachable: placeholder handled above");
    }

    await db.query(
      `update public.leads
          set company_id = $2, company = (select name from public.companies where id = $2), company_link_checked_at = now(), hot_score_dirty = true
        where id = $1`,
      [leadId, companyId],
    );
    await openCandidates(db, workspaceId, companyId, lead, domain, match.candidates);
    if (match.action === "create") await openSimilarNameCandidates(db, workspaceId, companyId, match.normalizedName);
    return { action: match.action, companyId };
  }
  throw new Error("Company was created concurrently but could not be found.");
}

/**
 * linkCompanyForLead inside a SAVEPOINT. Never throws: on failure the company work
 * is rolled back, the lead's attempt counter goes up and company_link_checked_at
 * stays null, so the worker's sweeper retries it. Logs codes only, never names.
 */
export async function linkCompanySafely(db: Queryable, workspaceId: string, leadId: string): Promise<CompanyLinkResult | null> {
  try {
    await db.query("savepoint company_link");
  } catch (error) {
    console.warn(`[companies] link for lead ${leadId} skipped: ${errorCode(error)}`);
    return null;
  }
  try {
    const result = await linkCompanyForLead(db, workspaceId, leadId);
    await db.query("release savepoint company_link");
    return result;
  } catch (error) {
    console.warn(`[companies] link for lead ${leadId} failed: ${errorCode(error)}`);
    try {
      await db.query("rollback to savepoint company_link");
      await db.query("release savepoint company_link");
      await db.query(
        `update public.leads set company_link_attempts = least(company_link_attempts + 1, 32767), company_link_checked_at = null where id = $1`,
        [leadId],
      );
    } catch (cleanupError) {
      console.warn(`[companies] link failure for lead ${leadId} not recorded: ${errorCode(cleanupError)}`);
    }
    return null;
  }
}

// Codes / class names only: a pg message can quote row values.
function errorCode(error: unknown): string {
  const e = error as { code?: string; name?: string };
  return e?.code ?? e?.name ?? "unknown error";
}

interface CompanyRow {
  id: string;
  name: string;
  merged_into_company_id: string | null;
}

// Empty target fields are filled from the source; revenue moves as one group so min <= max holds.
const FILLABLE_FIELDS = ["domain", "website", "industry", "city", "state", "country", "linkedin_url", "employee_range", "description", "owner_id"] as const;

/**
 * Merges `sourceId` into `targetId` (B2-design §2.1). Re-points contacts (and their
 * company text) and deals, fills the target's empty fields, hides the source and
 * marks the pair's open duplicate suggestions merged. Never deletes anything.
 */
export async function mergeCompanies(db: Queryable, actor: Actor, workspaceId: string, targetId: string, sourceId: string) {
  if (targetId === sourceId) throw new ValidationError("A company can't be merged into itself.");
  const { rows } = await db.query<CompanyRow>(
    `select id, name, merged_into_company_id from public.companies
      where workspace_id = $1 and id = any($2::uuid[])
      order by id for update`,
    [workspaceId, [targetId, sourceId]],
  );
  const target = rows.find((r) => r.id === targetId);
  const source = rows.find((r) => r.id === sourceId);
  if (!target || !source) throw new NotFoundError("Company");
  if (target.merged_into_company_id || source.merged_into_company_id) throw new ConflictError("One of these companies was already merged.");

  // Hide the source first: it frees its name/domain in the unique indexes for the fill below.
  await db.query(`update public.companies set merged_into_company_id = $2 where id = $1`, [sourceId, targetId]);
  await db.query(
    `update public.companies t
        set ${FILLABLE_FIELDS.map((f) => `${f} = coalesce(t.${f}, s.${f})`).join(", ")},
            revenue_range = case when t.revenue_range is null and t.revenue_min_cr is null and t.revenue_max_cr is null then s.revenue_range else t.revenue_range end,
            revenue_min_cr = case when t.revenue_range is null and t.revenue_min_cr is null and t.revenue_max_cr is null then s.revenue_min_cr else t.revenue_min_cr end,
            revenue_max_cr = case when t.revenue_range is null and t.revenue_min_cr is null and t.revenue_max_cr is null then s.revenue_max_cr else t.revenue_max_cr end
       from public.companies s
      where t.id = $1 and s.id = $2`,
    [targetId, sourceId],
  );

  const moved = await db.query<{ id: string }>(
    `update public.leads set company_id = $2, company = $3 where workspace_id = $1 and company_id = $4 returning id`,
    [workspaceId, targetId, target.name, sourceId],
  );
  await db.query(`update public.deals set company_id = $2 where workspace_id = $1 and company_id = $3`, [workspaceId, targetId, sourceId]);
  for (const { id } of moved.rows) {
    await addTimelineEvent(db, {
      leadId: id,
      kind: "system",
      title: "Company merged",
      detail: `${source.name} was merged into ${target.name}.`,
      ...actorEvent(actor),
      metadata: { fromCompanyId: sourceId, toCompanyId: targetId },
    });
  }

  const [a, b] = [targetId, sourceId].sort();
  await db.query(
    `update public.company_duplicate_candidates
        set status = 'merged', resolved_by = $3, resolved_at = now()
      where company_a_id = $1 and company_b_id = $2 and status = 'open'`,
    [a, b, actor.id],
  );
  await repointOpenCandidates(db, actor, workspaceId, targetId, sourceId);
  return { targetId, sourceId, movedContacts: moved.rowCount ?? 0 };
}

/**
 * After a merge, the source's other OPEN suggestions move to the target. A pair that
 * would become (target, target), or a row that already exists for the target in any
 * status (the unique keys ignore status), is dismissed instead.
 */
async function repointOpenCandidates(db: Queryable, actor: Actor, workspaceId: string, targetId: string, sourceId: string) {
  const OTHER = `(case when c.company_a_id = $2 then c.company_b_id else c.company_a_id end)`;
  const OPEN_PAIRS = `c.workspace_id = $1 and c.status = 'open' and c.company_b_id is not null and $2 in (c.company_a_id, c.company_b_id)`;
  const OPEN_CONTACT_ROWS = `c.workspace_id = $1 and c.status = 'open' and c.company_b_id is null and c.company_a_id = $2`;
  await db.query(
    `update public.company_duplicate_candidates c set status = 'dismissed', resolved_by = $4, resolved_at = now()
      where ${OPEN_PAIRS}
        and (${OTHER} = $3 or exists (
              select 1 from public.company_duplicate_candidates e
               where e.company_a_id = least($3::uuid, ${OTHER}) and e.company_b_id = greatest($3::uuid, ${OTHER})))`,
    [workspaceId, sourceId, targetId, actor.id],
  );
  await db.query(
    `update public.company_duplicate_candidates c
        set company_a_id = least($3::uuid, ${OTHER}), company_b_id = greatest($3::uuid, ${OTHER})
      where ${OPEN_PAIRS}`,
    [workspaceId, sourceId, targetId],
  );
  await db.query(
    `update public.company_duplicate_candidates c set status = 'dismissed', resolved_by = $4, resolved_at = now()
      where ${OPEN_CONTACT_ROWS}
        and exists (select 1 from public.company_duplicate_candidates e where e.company_b_id is null and e.company_a_id = $3 and e.lead_id = c.lead_id)`,
    [workspaceId, sourceId, targetId, actor.id],
  );
  await db.query(`update public.company_duplicate_candidates c set company_a_id = $3 where ${OPEN_CONTACT_ROWS}`, [workspaceId, sourceId, targetId]);
}

export interface CompanySweepCounts {
  processed: number;
  linked: number;
  created: number;
  none: number;
  failed: number;
}

/**
 * The company sweeper (B2-design §3): links contacts that were never checked
 * (old data) or whose inline link failed. Up to `limit` per call, picked up front
 * round-robin across workspaces, oldest first (P7: one big import can't hold back
 * the others), on ONE connection with one short transaction per contact; SKIP
 * LOCKED makes it safe with several workers. A contact that fails is not retried
 * in the same pass, and is given up after MAX_COMPANY_LINK_ATTEMPTS. `workspaceId`
 * is for tests and scripts. Returns counts only (callers log no names).
 */
export async function runCompanySweep(options: { limit?: number; workspaceId?: string } = {}): Promise<CompanySweepCounts> {
  const limit = options.limit ?? 200;
  const counts: CompanySweepCounts = { processed: 0, linked: 0, created: 0, none: 0, failed: 0 };
  const client = await pool.connect();
  try {
    const candidates = (
      await client.query<{ k: string }>(
        fairPickSql({
          from: "public.leads x",
          where: "x.company_link_checked_at is null and x.company_link_attempts < $1 and x.merged_into_lead_id is null and ($2::uuid is null or x.workspace_id = $2::uuid)",
          order: "x.created_at",
          limit: "$3",
        }),
        [MAX_COMPANY_LINK_ATTEMPTS, options.workspaceId ?? null, limit],
      )
    ).rows;
    for (const { k: candidate } of candidates) {
      await client.query("begin");
      try {
        const next = (
          await client.query<{ id: string; workspace_id: string }>(
            `select id, workspace_id from public.leads
              where id = $1 and company_link_checked_at is null and company_link_attempts < $2 and merged_into_lead_id is null
              for update skip locked`,
            [candidate, MAX_COMPANY_LINK_ATTEMPTS],
          )
        ).rows[0];
        if (!next) {
          // Linked meanwhile, or another worker holds it.
          await client.query("commit");
          continue;
        }
        const result = await linkCompanySafely(client, next.workspace_id, next.id);
        await client.query("commit");
        counts.processed++;
        if (!result) counts.failed++;
        else if (result.action === "link") counts.linked++;
        else if (result.action === "create") counts.created++;
        else counts.none++;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    }
  } finally {
    client.release();
  }
  return counts;
}
