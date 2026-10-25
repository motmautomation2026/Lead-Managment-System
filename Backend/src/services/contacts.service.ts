/**
 * CRM v2 contacts list (B4): rows in `leads`, read through the list standard
 * (lists/listQuery.ts). Writes stay on the existing /leads routes; bulk actions
 * call the existing updateLead / enrollLeads per contact.
 */
import { z } from "zod";
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { withTransaction } from "../db.js";
import { AppError, ValidationError } from "../errors.js";
import { LEAD_SOURCES, LIFECYCLE_STATES, PIPELINE_STAGES } from "../domain/enums.js";
import type { AgentStatus } from "../agent/rules.js";
import {
  addOwnerFilter,
  addRange,
  containsPattern,
  leadSearchSql,
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
import { getLeadRowOr404, leadToDto, loadNextActions, updateLead } from "./leads.service.js";
import { getLeadNextAction } from "./tasks.service.js";
import { getProfile } from "./profiles.service.js";
import { enrollLeads } from "./agentStatus.service.js";

const AGENT_STATUSES = ["none", "active", "paused", "handed_off", "stopped"] as const satisfies readonly AgentStatus[];
const OPEN_DEAL = `d.stage not in ('won', 'lost')`;

export const CONTACT_SORTS = defineSorts({
  idColumn: "l.id",
  defaultSort: "createdAt:desc",
  fields: {
    createdAt: { columns: ["l.created_at"], type: "timestamptz" },
    lastActivityAt: { columns: ["l.last_activity_at"], type: "timestamptz" },
    updatedAt: { columns: ["l.updated_at"], type: "timestamptz" },
    name: { columns: ["l.last_name", "l.first_name"], type: "text" },
    company: { columns: ["l.company"], type: "text" },
  },
});

/** Filters for GET /contacts and /contacts/count (also what a saved contacts view stores). */
export const contactFilterSchema = z
  .object({
    ownerId: ownerIdFilter.optional(),
    leadStatus: multi(z.enum(PIPELINE_STAGES)).optional(),
    lifecycle: multi(z.enum([...LIFECYCLE_STATES, "all"])).optional(),
    source: multi(z.enum(LEAD_SOURCES)).optional(),
    companyId: z.string().uuid().optional(),
    agentStatus: multi(z.enum(AGENT_STATUSES)).optional(),
    hasOpenDeal: strictBoolean.optional(),
    createdFrom: isoTimestamp.optional(),
    createdTo: isoTimestamp.optional(),
    lastActivityFrom: isoTimestamp.optional(),
    lastActivityTo: isoTimestamp.optional(),
    q: searchQuery.optional(),
  })
  .strict();
export const contactSortSchema = sortParam(CONTACT_SORTS);
export const contactListSchema = contactFilterSchema.extend({ ...pageParams, sort: contactSortSchema }).strict();
export type ContactFilters = z.infer<typeof contactFilterSchema>;

/** Column ids a saved contacts view may show. */
export const CONTACT_COLUMNS = [
  "name", "email", "phone", "jobTitle", "company", "owner", "leadStatus", "lifecycle", "openDeal", "agentStatus", "nextAction", "lastActivityAt", "createdAt", "source",
] as const;

const DEFAULT_LIFECYCLES = ["active", "long_term_nurture"];

function contactWhere(workspaceId: string, actor: Actor, f: ContactFilters): SqlBuilder {
  const b = new SqlBuilder();
  b.and(`l.workspace_id = ${b.p(workspaceId)}`);
  const lifecycle = f.lifecycle ?? DEFAULT_LIFECYCLES;
  // `all` = every state except merged; merged contacts appear only when asked for by name.
  if (lifecycle.includes("all")) b.and(`l.lifecycle_state <> 'merged'`);
  else b.and(`l.lifecycle_state = any(${b.p(lifecycle)}::public.lead_lifecycle_state[])`);
  addOwnerFilter(b, "l.owner_id", f.ownerId, actor.id);
  if (f.leadStatus) b.and(`l.pipeline_stage = any(${b.p(f.leadStatus)}::public.pipeline_stage[])`);
  if (f.source) b.and(`l.source::text = any(${b.p(f.source)}::text[])`);
  if (f.companyId) b.and(`l.company_id = ${b.p(f.companyId)}`);
  if (f.agentStatus) b.and(`l.agent_status::text = any(${b.p(f.agentStatus)}::text[])`);
  if (f.hasOpenDeal !== undefined) b.and(`${f.hasOpenDeal ? "" : "not "}exists (select 1 from public.deals d where d.lead_id = l.id and ${OPEN_DEAL})`);
  addRange(b, "l.created_at", f.createdFrom, f.createdTo, "timestamptz");
  addRange(b, "l.last_activity_at", f.lastActivityFrom, f.lastActivityTo, "timestamptz");
  if (f.q) {
    const q = b.p(containsPattern(f.q));
    b.and(leadSearchSql(q));
  }
  return b;
}

interface ContactListRow {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  source: string;
  company: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  leadStatus: string;
  lifecycle: string;
  openDeal: { id: string; name: string; stage: string; amount: number | null; currency: string } | null;
  agentStatus: string;
  lastActivityAt: Date;
  createdAt: Date;
}

export async function listContacts(db: Queryable, actor: Actor, workspaceId: string, query: z.infer<typeof contactListSchema>) {
  const b = contactWhere(workspaceId, actor, query);
  const page = await runPage<ContactListRow>(db, b, query.sort, query, ({ where, orderBy, limit, cursorSelect }) =>
    `select l.id, trim(l.first_name || ' ' || l.last_name) as name, l.first_name as "firstName", l.last_name as "lastName",
            l.email, l.phone, l.job_title as "jobTitle", l.source,
            case when c.id is null then null else json_build_object('id', c.id, 'name', c.name) end as company,
            case when o.id is null then null else json_build_object('id', o.id, 'name', o.full_name) end as owner,
            l.pipeline_stage as "leadStatus", l.lifecycle_state as lifecycle, od.deal as "openDeal",
            l.agent_status as "agentStatus", l.last_activity_at as "lastActivityAt", l.created_at as "createdAt",
            ${cursorSelect}
       from public.leads l
       left join public.companies c on c.id = l.company_id
       left join public.profiles o on o.id = l.owner_id
       left join lateral (
         select json_build_object('id', d.id, 'name', d.name, 'stage', d.stage, 'amount', d.amount, 'currency', d.currency) as deal
           from public.deals d where d.lead_id = l.id and ${OPEN_DEAL}
          order by d.updated_at desc, d.id desc limit 1) od on true
      ${where}
      order by ${orderBy}
      limit ${limit}`,
  );
  const nextActions = await loadNextActions(db, page.data.map((r) => r.id));
  return { data: page.data.map((row) => ({ ...row, nextAction: nextActions.get(row.id) ?? null })), nextCursor: page.nextCursor };
}

export const countContacts = (db: Queryable, actor: Actor, workspaceId: string, filters: ContactFilters) =>
  runCount(db, contactWhere(workspaceId, actor, filters), "public.leads l");

/** The Lead DTO plus its company and deals (newest first). The DTO's company text moves to `companyText`. */
export async function getContact(db: Queryable, workspaceId: string, id: string) {
  const row = await getLeadRowOr404(db, workspaceId, id);
  const [nextAction, company, deals] = await Promise.all([
    getLeadNextAction(db, id),
    row.company_id
      ? db.query<{ id: string; name: string; domain: string | null }>(`select id, name, domain from public.companies where id = $1`, [row.company_id])
      : null,
    db.query(
      `select id, name, stage, amount::float8 as amount, currency, closed_at as "closedAt"
         from public.deals where lead_id = $1 and workspace_id = $2 order by updated_at desc, id desc`,
      [id, workspaceId],
    ),
  ]);
  const dto = leadToDto(row, nextAction);
  return { ...dto, companyText: dto.company, company: company?.rows[0] ?? null, deals: deals.rows };
}

export const contactBulkSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(100),
    action: z.enum(["assignOwner", "enrollAi"]),
    ownerId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => v.action !== "assignOwner" || v.ownerId, { message: "assignOwner needs an ownerId.", path: ["ownerId"] });

export interface BulkResult {
  id: string;
  ok: boolean;
  error?: string;
}

const ENROLL_SKIP_MESSAGES: Record<string, string> = {
  not_found: "Contact not found.",
  not_eligible: "This contact can't be enrolled in its current state.",
  already_active: "Already enrolled in AI.",
  permanently_stopped: "AI was stopped for this contact permanently.",
  no_contact: "No email or phone to contact.",
};

/** One transaction per contact; one failure never stops the others. The caller enforces admin-only enrollAi. */
export async function bulkContacts(db: Queryable, actor: Actor, workspaceId: string, input: z.infer<typeof contactBulkSchema>): Promise<BulkResult[]> {
  const ids = [...new Set(input.ids)];
  if (input.action === "enrollAi") {
    const results = await enrollLeads(db, actor, workspaceId, ids);
    return results.map((r) =>
      r.result === "enrolled" ? { id: r.leadId, ok: true } : { id: r.leadId, ok: false, error: r.result === "failed" ? r.message : ENROLL_SKIP_MESSAGES[r.reason] },
    );
  }
  const owner = await getProfile(db, input.ownerId!);
  if (!owner?.active) throw new ValidationError("The new owner must be an active user.", { field: "ownerId" });
  const results: BulkResult[] = [];
  for (const id of ids) {
    try {
      await withTransaction((client) => updateLead(client, actor, workspaceId, id, { ownerId: owner.id }));
      results.push({ id, ok: true });
    } catch (error) {
      if (!(error instanceof AppError)) console.error(`[contacts] bulk assignOwner failed for ${id}:`, error);
      results.push({ id, ok: false, error: error instanceof AppError ? error.message.replace(/^Lead/, "Contact") : "Couldn't update this contact." });
    }
  }
  return results;
}
