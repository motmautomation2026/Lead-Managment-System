/**
 * CRM v2 deals API (B4): list (list standard), count, board, detail, manual create,
 * edit and manual stage moves. Creation and stage rules stay in deals.service.ts
 * (createDeal / moveDealStage) and domain/dealRouting.ts.
 */
import { z } from "zod";
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { DEAL_STAGES, LEAD_LOSS_REASONS, type DealStage } from "../domain/enums.js";
import {
  addOwnerFilter,
  addRange,
  containsPattern,
  defineSorts,
  isoDate,
  isoTimestamp,
  multi,
  nonNegativeNumber,
  ownerIdFilter,
  pageParams,
  runCount,
  runPage,
  searchQuery,
  sortParam,
  SqlBuilder,
  type ListSort,
} from "../lists/listQuery.js";
import { createDeal, moveDealStage } from "./deals.service.js";
import { getProfile } from "./profiles.service.js";
import { assertCompanyUsable } from "./companyRecords.service.js";

export const DEAL_SORTS = defineSorts({
  idColumn: "d.id",
  defaultSort: "updatedAt:desc",
  fields: {
    updatedAt: { columns: ["d.updated_at"], type: "timestamptz" },
    createdAt: { columns: ["d.created_at"], type: "timestamptz" },
    amount: { columns: ["d.amount"], type: "numeric", nullable: true },
    expectedCloseDate: { columns: ["d.expected_close_date"], type: "date", nullable: true },
    name: { columns: ["d.name"], type: "text" },
  },
});

export const dealFilterSchema = z
  .object({
    stage: multi(z.enum(DEAL_STAGES)).optional(),
    ownerId: ownerIdFilter.optional(),
    companyId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    status: z.enum(["open", "won", "lost", "all"]).optional(),
    amountMin: nonNegativeNumber.optional(),
    amountMax: nonNegativeNumber.optional(),
    expectedCloseFrom: isoDate.optional(),
    expectedCloseTo: isoDate.optional(),
    createdFrom: isoTimestamp.optional(),
    createdTo: isoTimestamp.optional(),
    q: searchQuery.optional(),
  })
  .strict();
export const dealSortSchema = sortParam(DEAL_SORTS);
export const dealListSchema = dealFilterSchema.extend({ ...pageParams, sort: dealSortSchema }).strict();
export const dealBoardSchema = dealFilterSchema.omit({ stage: true }).strict();
export type DealFilters = z.infer<typeof dealFilterSchema>;

export const DEAL_COLUMNS = ["name", "stage", "amount", "expectedCloseDate", "owner", "company", "contact", "source", "closedAt", "createdAt", "updatedAt"] as const;

const BOARD_PAGE = 20;
const FROM = `public.deals d left join public.companies c on c.id = d.company_id`;

function dealWhere(workspaceId: string, actor: Actor, f: DealFilters): SqlBuilder {
  const b = new SqlBuilder();
  b.and(`d.workspace_id = ${b.p(workspaceId)}`);
  // Default open, unless stages are named (then e.g. stage=won works on its own).
  const status = f.status ?? (f.stage ? "all" : "open");
  if (status === "open") b.and(`d.stage not in ('won', 'lost')`);
  else if (status !== "all") b.and(`d.stage = ${b.p(status)}::public.deal_stage`);
  if (f.stage) b.and(`d.stage = any(${b.p(f.stage)}::public.deal_stage[])`);
  addOwnerFilter(b, "d.owner_id", f.ownerId, actor.id);
  if (f.companyId) b.and(`d.company_id = ${b.p(f.companyId)}`);
  if (f.leadId) b.and(`d.lead_id = ${b.p(f.leadId)}`);
  addRange(b, "d.amount", f.amountMin, f.amountMax, "numeric");
  addRange(b, "d.expected_close_date", f.expectedCloseFrom, f.expectedCloseTo, "date");
  addRange(b, "d.created_at", f.createdFrom, f.createdTo, "timestamptz");
  if (f.q) {
    const q = b.p(containsPattern(f.q));
    b.and(`(d.name ilike ${q} or c.name ilike ${q})`);
  }
  return b;
}

const OWNER_JSON = `case when o.id is null then null else json_build_object('id', o.id, 'name', o.full_name) end`;
const COMPANY_JSON = `case when c.id is null then null else json_build_object('id', c.id, 'name', c.name) end`;
const CONTACT_NAME = `trim(l.first_name || ' ' || l.last_name)`;

function pageOfDeals(db: Queryable, b: SqlBuilder, sort: ListSort, page: { limit: number; cursor?: string | undefined }) {
  return runPage(db, b, sort, page, ({ where, orderBy, limit, cursorSelect }) =>
    `select d.id, d.name, d.stage, d.amount::float8 as amount, d.currency, d.expected_close_date::text as "expectedCloseDate",
            ${OWNER_JSON} as owner, ${COMPANY_JSON} as company, json_build_object('id', l.id, 'name', ${CONTACT_NAME}) as contact,
            d.source, d.closed_at as "closedAt", d.created_at as "createdAt", d.updated_at as "updatedAt", ${cursorSelect}
       from ${FROM}
       join public.leads l on l.id = d.lead_id
       left join public.profiles o on o.id = d.owner_id
      ${where}
      order by ${orderBy}
      limit ${limit}`,
  );
}

export const listDeals = (db: Queryable, actor: Actor, workspaceId: string, query: z.infer<typeof dealListSchema>) =>
  pageOfDeals(db, dealWhere(workspaceId, actor, query), query.sort, query);

export const countDeals = (db: Queryable, actor: Actor, workspaceId: string, filters: DealFilters) => runCount(db, dealWhere(workspaceId, actor, filters), FROM);

/**
 * Every stage in pipeline order with its count, INR amount total and first 20 deals by
 * updatedAt desc; a column loads more via GET /deals?stage=X&sort=updatedAt:desc&cursor=….
 */
export async function dealBoard(db: Queryable, actor: Actor, workspaceId: string, filters: z.infer<typeof dealBoardSchema>) {
  const totals = dealWhere(workspaceId, actor, filters);
  const { rows } = await db.query<{ stage: DealStage; count: number; amount_total: number }>(
    `select d.stage, count(*)::int as count, coalesce(sum(d.amount) filter (where d.currency = 'INR'), 0)::float8 as amount_total
       from ${FROM} ${totals.where()} group by d.stage`,
    totals.params,
  );
  const sort = dealSortSchema.parse("updatedAt:desc");
  return {
    data: await Promise.all(
      DEAL_STAGES.map(async (stage) => {
        const total = rows.find((r) => r.stage === stage);
        const page = total
          ? await pageOfDeals(db, dealWhere(workspaceId, actor, { ...filters, stage: [stage] }), sort, { limit: BOARD_PAGE })
          : { data: [], nextCursor: null };
        return { stage, count: total?.count ?? 0, amountTotal: total?.amount_total ?? 0, items: page.data, nextCursor: page.nextCursor };
      }),
    ),
  };
}

/** All fields + contact, company, owner and the meetings and proposals linked by deal_id. */
export async function getDeal(db: Queryable, workspaceId: string, id: string) {
  const { rows } = await db.query(
    `select d.id, d.name, d.stage, d.amount::float8 as amount, d.currency, d.expected_close_date::text as "expectedCloseDate",
            d.service_interest as "serviceInterest", d.source, d.loss_reason as "lossReason", d.loss_notes as "lossNotes",
            d.closed_at as "closedAt", d.created_by_name as "createdBy", d.created_at as "createdAt", d.updated_at as "updatedAt",
            ${OWNER_JSON} as owner, ${COMPANY_JSON} as company,
            json_build_object('id', l.id, 'name', ${CONTACT_NAME}, 'email', l.email, 'phone', l.phone, 'lifecycle', l.lifecycle_state) as contact,
            coalesce((select json_agg(json_build_object('id', m.id, 'title', m.title, 'at', m.scheduled_at, 'status', m.status, 'outcome', m.outcome)
                                order by m.scheduled_at desc)
                        from public.meetings m where m.deal_id = d.id), '[]') as meetings,
            coalesce((select json_agg(json_build_object('id', p.id, 'title', p.title, 'amount', p.amount, 'currency', p.currency,
                                                        'status', p.status, 'sentAt', p.sent_at, 'updatedAt', p.updated_at)
                                order by p.updated_at desc)
                        from public.proposals p where p.deal_id = d.id), '[]') as proposals
       from ${FROM}
       join public.leads l on l.id = d.lead_id
       left join public.profiles o on o.id = d.owner_id
      where d.id = $1 and d.workspace_id = $2`,
    [id, workspaceId],
  );
  if (!rows[0]) throw new NotFoundError("Deal");
  return rows[0] as Record<string, unknown>;
}

const INR_ONLY = z.literal("INR", { errorMap: () => ({ message: "Only INR is supported for now." }) });
const amount = z.number().nonnegative().max(999_999_999_999.99).nullable().optional();
const closeDate = isoDate.nullable().optional();

export const createDealSchema = z
  .object({
    leadId: z.string().uuid(),
    name: z.string().trim().min(1).max(300).optional(),
    stage: z.enum(DEAL_STAGES).optional(),
    amount,
    currency: INR_ONLY.optional(),
    expectedCloseDate: closeDate,
    lossReason: z.enum(LEAD_LOSS_REASONS).optional(),
    lossNotes: z.string().trim().max(2000).optional(),
  })
  .strict();

export const updateDealSchema = z
  .object({
    name: z.string().trim().min(1).max(300).optional(),
    amount,
    currency: INR_ONLY.optional(),
    expectedCloseDate: closeDate,
    ownerId: z.string().uuid().nullable().optional(),
    companyId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const moveStageSchema = z
  .object({ stage: z.enum(DEAL_STAGES), lossReason: z.enum(LEAD_LOSS_REASONS).optional(), lossNotes: z.string().trim().max(2000).optional() })
  .strict();

/** Manual deal for a contact (stage default qualified). */
export async function createManualDeal(db: Queryable, actor: Actor, workspaceId: string, input: z.infer<typeof createDealSchema>) {
  const deal = await createDeal(db, actor, workspaceId, { ...input, source: "manual" });
  return getDeal(db, workspaceId, deal.id);
}

/** Edits a deal's fields; stage moves go through moveDeal (POST /deals/:id/stage). */
export async function updateDeal(db: Queryable, workspaceId: string, id: string, patch: z.infer<typeof updateDealSchema>) {
  const exists = await db.query(`select 1 from public.deals where id = $1 and workspace_id = $2 for update`, [id, workspaceId]);
  if (!exists.rowCount) throw new NotFoundError("Deal");
  if (patch.ownerId) {
    const owner = await getProfile(db, patch.ownerId);
    if (!owner?.active) throw new ValidationError("The owner must be an active user.", { field: "ownerId" });
  }
  if (patch.companyId) await assertCompanyUsable(db, workspaceId, patch.companyId);

  const b = new SqlBuilder();
  const sets: string[] = [];
  const set = (column: string, value: unknown) => sets.push(`${column} = ${b.p(value)}`);
  if (patch.name !== undefined) set("name", patch.name);
  if (patch.amount !== undefined) set("amount", patch.amount);
  if (patch.currency !== undefined) set("currency", patch.currency);
  if (patch.expectedCloseDate !== undefined) set("expected_close_date", patch.expectedCloseDate);
  if (patch.ownerId !== undefined) set("owner_id", patch.ownerId);
  if (patch.companyId !== undefined) set("company_id", patch.companyId);
  if (sets.length) await db.query(`update public.deals set ${sets.join(", ")} where id = ${b.p(id)}`, b.params);
  return getDeal(db, workspaceId, id);
}

/** Manual stage move (B3b rules, incl. the contact sync on won). Moving to the current stage is a 409. */
export async function moveDeal(db: Queryable, actor: Actor, workspaceId: string, id: string, input: z.infer<typeof moveStageSchema>) {
  const { moved } = await moveDealStage(db, actor, workspaceId, id, input.stage, { manual: true, lossReason: input.lossReason, lossNotes: input.lossNotes });
  if (!moved) throw new ConflictError("The deal is already in this stage.");
  return getDeal(db, workspaceId, id);
}
