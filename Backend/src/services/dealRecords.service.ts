/**
 * CRM v2 deals API (B4): list (list standard), count, board, detail, manual create,
 * edit and manual stage moves. Creation and stage rules stay in deals.service.ts
 * (createDeal / moveDealStage) and domain/dealRouting.ts.
 */
import { z } from "zod";
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { DEAL_STAGES, LEAD_LOSS_REASONS, type DealStage } from "../domain/enums.js";
import {
  addOwnerFilter,
  addRange,
  containsPattern,
  cursorSelectSql,
  defineSorts,
  encodeCursor,
  isoDate,
  isoTimestamp,
  multi,
  nonNegativeNumber,
  orderBySql,
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
import { assertAssignableUser } from "./profiles.service.js";
import { assertCompanyUsable } from "./companyRecords.service.js";
import { markLost, moveToLongTermNurture } from "./leads.service.js";

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

const LIST_ITEM_SELECT = `d.id, d.name, d.stage, d.amount::float8 as amount, d.currency, d.expected_close_date::text as "expectedCloseDate",
            ${OWNER_JSON} as owner, ${COMPANY_JSON} as company, json_build_object('id', l.id, 'name', ${CONTACT_NAME}) as contact,
            d.source, d.closed_at as "closedAt", d.created_at as "createdAt", d.updated_at as "updatedAt"`;

function pageOfDeals(db: Queryable, b: SqlBuilder, sort: ListSort, page: { limit: number; cursor?: string | undefined }) {
  return runPage(db, b, sort, page, ({ where, orderBy, limit, cursorSelect }) =>
    `select ${LIST_ITEM_SELECT}, ${cursorSelect}
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
 * ONE query: per-stage window counts/totals/row numbers over the filtered deals, then the
 * first 21 rows of each stage (the 21st only says there is more). Cursors match GET /deals.
 */
export async function dealBoard(db: Queryable, actor: Actor, workspaceId: string, filters: z.infer<typeof dealBoardSchema>) {
  const b = dealWhere(workspaceId, actor, filters);
  const sort = dealSortSchema.parse("updatedAt:desc");
  const { rows } = await db.query<BoardRow>(
    `with ranked as (
       select d.id,
              row_number() over (partition by d.stage order by ${orderBySql(sort)})::int as rn,
              count(*) over (partition by d.stage)::int as stage_count,
              coalesce(sum(d.amount) filter (where d.currency = 'INR') over (partition by d.stage), 0)::float8 as stage_total
         from ${FROM} ${b.where()}
     )
     select ${LIST_ITEM_SELECT}, r.rn, r.stage_count, r.stage_total, ${cursorSelectSql(sort)}
       from ranked r
       join public.deals d on d.id = r.id
       left join public.companies c on c.id = d.company_id
       join public.leads l on l.id = d.lead_id
       left join public.profiles o on o.id = d.owner_id
      where r.rn <= ${b.p(BOARD_PAGE + 1)}
      order by r.rn`,
    b.params,
  );
  return {
    data: DEAL_STAGES.map((stage) => {
      const stageRows = rows.filter((r) => r.stage === stage);
      const items = stageRows.filter((r) => r.rn <= BOARD_PAGE);
      const last = items[items.length - 1];
      return {
        stage,
        count: stageRows[0]?.stage_count ?? 0,
        amountTotal: stageRows[0]?.stage_total ?? 0,
        items: items.map(({ rn: _rn, stage_count: _count, stage_total: _total, __cursor: _cursor, ...item }) => item),
        nextCursor: stageRows.length > BOARD_PAGE && last ? encodeCursor(sort, last.__cursor) : null,
      };
    }),
  };
}

type BoardRow = Record<string, unknown> & { stage: DealStage; rn: number; stage_count: number; stage_total: number; __cursor: (string | null)[] };

/** 404 unless the deal exists in this workspace (cheap check for its sub-resources). */
export async function assertDealExists(db: Queryable, workspaceId: string, id: string) {
  const { rowCount } = await db.query(`select 1 from public.deals where id = $1 and workspace_id = $2`, [id, workspaceId]);
  if (!rowCount) throw new NotFoundError("Deal");
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
    ownerId: z.string().uuid().nullable().optional(),
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

/** What closing a deal as lost does to its contact; the rep decides (design §2.2). */
export const CONTACT_ACTIONS = ["keep", "long_term_nurture", "lost"] as const;

export const moveStageSchema = z
  .object({
    stage: z.enum(DEAL_STAGES),
    lossReason: z.enum(LEAD_LOSS_REASONS).optional(),
    lossNotes: z.string().trim().max(2000).optional(),
    contactAction: z.enum(CONTACT_ACTIONS).optional(),
  })
  .strict()
  .refine((v) => !v.contactAction || v.stage === "lost", { message: "contactAction is only allowed when the stage is lost.", path: ["contactAction"] });

/** Manual deal for a contact (stage default qualified). */
export async function createManualDeal(db: Queryable, actor: Actor, workspaceId: string, input: z.infer<typeof createDealSchema>) {
  if (input.ownerId) await assertAssignableUser(db, workspaceId, input.ownerId);
  const deal = await createDeal(db, actor, workspaceId, { ...input, source: "manual" });
  return getDeal(db, workspaceId, deal.id);
}

/** Edits a deal's fields; stage moves go through moveDeal (POST /deals/:id/stage). */
export async function updateDeal(db: Queryable, workspaceId: string, id: string, patch: z.infer<typeof updateDealSchema>) {
  const exists = await db.query<{ owner_id: string | null }>(`select owner_id from public.deals where id = $1 and workspace_id = $2 for update`, [id, workspaceId]);
  if (!exists.rowCount) throw new NotFoundError("Deal");
  // E4b rule 5: a new owner must be a member (an unchanged owner is kept as it is).
  if (patch.ownerId && patch.ownerId !== exists.rows[0]!.owner_id) await assertAssignableUser(db, workspaceId, patch.ownerId);
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

/**
 * Manual stage move (B3b rules, incl. the contact sync on won). Moving to the current stage is a 409.
 * Lost + `contactAction` also moves the contact through the existing lifecycle services in the same
 * transaction (a DNC contact fails the whole move): `lost` with the deal's reason and notes (like any
 * lost contact, that also closes its other open deals) or `long_term_nurture`; `keep` changes nothing.
 */
export async function moveDeal(db: Queryable, actor: Actor, workspaceId: string, id: string, input: z.infer<typeof moveStageSchema>) {
  const { deal, moved } = await moveDealStage(db, actor, workspaceId, id, input.stage, { manual: true, lossReason: input.lossReason, lossNotes: input.lossNotes });
  if (!moved) throw new ConflictError("The deal is already in this stage.");
  if (input.contactAction === "lost") await markLost(db, actor, workspaceId, deal.lead_id, input.lossReason!, input.lossNotes);
  else if (input.contactAction === "long_term_nurture") await moveToLongTermNurture(db, actor, workspaceId, deal.lead_id, `Deal lost: ${deal.name}`);
  return getDeal(db, workspaceId, id);
}
