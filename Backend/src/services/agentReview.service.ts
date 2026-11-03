import type { Actor } from "../authMiddleware.js";
import type { Queryable } from "../dto.js";
import { ConflictError, ForbiddenError, InvalidTransitionError, NotFoundError, ValidationError } from "../errors.js";
import { composeOutgoing, type OutgoingMessage } from "../agent/composeMessage.js";
import type { AgentAction, SendDecision } from "../agent/decisionSchema.js";
import { goLiveReadiness, RATING_REASONS, type GoLiveReadiness, type RatingReason } from "../agent/readiness.js";
import { effectiveMode, type LiveScope } from "../agent/liveMode.js";
import { isUuid } from "../validation/parse.js";
import { IST_MONTH, MONTH_SPEND_SQL } from "./agentRunner.service.js";
import { liveContactSql } from "./agentSendState.service.js";

/**
 * Reviewing the agent's decisions (3D-1): the decision log, ratings, problem
 * reports, stats with the go-live gate, and the per-lead AI panel. Reads and
 * review metadata only; nothing is sent. Every query is workspace-scoped.
 */

export const DECISION_OUTCOMES = ["draft", "sent", "skipped", "blocked", "executed", "failed"] as const;
export const RATING_FILTERS = ["good", "bad", "unrated"] as const;
const PREVIEW_CHARS = 160;
const CHUNK_PREVIEW_CHARS = 300;
const PANEL_DECISIONS = 10;
const REPORT_DETAIL_CHARS = 300;

export interface DecisionFilters {
  action?: AgentAction | undefined;
  outcome?: (typeof DECISION_OUTCOMES)[number] | undefined;
  leadId?: string | undefined;
  rating?: (typeof RATING_FILTERS)[number] | undefined;
  hasOpenReport?: boolean | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  cursor?: string | undefined;
  limit: number;
}

// The headline of a decision: the email subject, handoff title, new stage or stop reason.
const HEADLINE = `case d.action when 'send_email' then d.message_subject when 'handoff' then d.handoff_title
  when 'update_stage' then d.new_stage when 'stop' then d.stop_reason end`;
const LEAD_NAME = `concat_ws(' ', l.first_name, nullif(l.last_name, ''))`;
const OPEN_REPORTS = `(select count(*)::int from public.agent_decision_reports r where r.decision_id = d.id and r.resolved_at is null)`;
// E2: a live decision's send state; channel for send decisions.
const SEND_COLUMNS = `d.mode, d.send_status as "sendStatus", d.sent_at as "sentAt", d.send_error as "sendError", d.cancel_reason as "cancelReason",
              case d.action when 'send_email' then 'email' when 'send_whatsapp' then 'whatsapp' end as channel,
              d.stage_key as "stageKey", d.angle`;
const IST_DAY = `date_trunc('day', now() at time zone 'Asia/Kolkata')`;

/** Opaque keyset cursor: the row's created_at as Postgres text (keeps microseconds) and id. */
const PG_TIMESTAMPTZ = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const encodeCursor =(at: string, id: string) => Buffer.from(JSON.stringify([at, id])).toString("base64url");
function decodeCursor(cursor: string): [string, string] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2) {
      const [at, id] = value as unknown[];
      if (typeof at === "string" && typeof id === "string" && isUuid(id) && PG_TIMESTAMPTZ.test(at)) return [at, id];
    }
  } catch {
    // falls through
  }
  throw new ValidationError("Invalid cursor.");
}

export async function listDecisions(db: Queryable, workspaceId: string, filters: DecisionFilters) {
  const where = ["d.workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  const add = (sql: (p: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };
  if (filters.action) add((p) => `d.action = ${p}`, filters.action);
  if (filters.outcome) add((p) => `d.outcome = ${p}`, filters.outcome);
  if (filters.leadId) add((p) => `d.lead_id = ${p}`, filters.leadId);
  if (filters.rating === "unrated") where.push("d.rating is null");
  else if (filters.rating) add((p) => `d.rating = ${p}`, filters.rating);
  if (filters.hasOpenReport !== undefined) where.push(`${filters.hasOpenReport ? "" : "not "}exists (select 1 from public.agent_decision_reports r where r.decision_id = d.id and r.resolved_at is null)`);
  if (filters.from) add((p) => `d.created_at >= ${p}`, filters.from);
  if (filters.to) add((p) => `d.created_at <= ${p}`, filters.to);
  if (filters.cursor) {
    const [at, id] = decodeCursor(filters.cursor);
    params.push(at, id);
    where.push(`(d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(filters.limit + 1);

  const rows = (
    await db.query<{ cursorAt: string; id: string } & Record<string, unknown>>(
      `select d.id, d.created_at as "createdAt", d.created_at::text as "cursorAt",
              json_build_object('id', l.id, 'name', ${LEAD_NAME}, 'company', l.company) as lead,
              o.full_name as "ownerName", d.action, d.outcome, ${HEADLINE} as subject,
              left(d.message_body, ${PREVIEW_CHARS}) as "bodyPreview", d.regenerated, d.rating,
              d.rating_reason as "ratingReason", ${OPEN_REPORTS} as "openReports", ${SEND_COLUMNS}
         from public.agent_decisions d
         join public.leads l on l.id = d.lead_id
         left join public.profiles o on o.id = l.owner_id
        where ${where.join(" and ")}
        order by d.created_at desc, d.id desc
        limit $${params.length}`,
      params,
    )
  ).rows;
  const page = rows.slice(0, filters.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(({ cursorAt: _cursorAt, ...row }) => row),
    nextCursor: rows.length > filters.limit && last ? encodeCursor(last.cursorAt, last.id) : null,
  };
}

// The company and open deal a decision saw (D1): current names, the deal's stage at the time; null before D1.
const DECISION_CONTEXT = `json_build_object(
    'company', case when dc.id is null then null else json_build_object('id', dc.id, 'name', dc.name) end,
    'deal', case when dd.id is null then null else json_build_object('id', dd.id, 'name', dd.name, 'stage', d.context_deal_stage) end)`;
const DECISION_CONTEXT_JOINS = `left join public.companies dc on dc.id = d.context_company_id and dc.workspace_id = d.workspace_id
         left join public.deals dd on dd.id = d.context_deal_id and dd.workspace_id = d.workspace_id`;

/**
 * E2g rule 7: the decision's attachments by title (sent = really went out), the ones the rules
 * dropped (the last attempt's quality_checks) and the ones left out at send time.
 */
const DECISION_ATTACHMENTS = `case when d.action not in ('send_email', 'send_whatsapp') then null else jsonb_build_object(
    'assets', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', aa.title,
                       'sent', coalesce(x.id = any(d.sent_asset_ids), false)) order by x.n), '[]'::jsonb)
                 from unnest(coalesce(d.asset_ids, '{}'::uuid[])) with ordinality x(id, n)
                 left join public.agent_assets aa on aa.id = x.id and aa.workspace_id = d.workspace_id),
    'removed', coalesce(d.quality_checks -> -1 -> 'attachmentsRemoved', '[]'::jsonb),
    'issues', coalesce(d.attachment_issues, '[]'::jsonb)) end`;

interface DecisionDetailRow {
  id: string;
  leadId: string;
  action: AgentAction;
  messageSubject: string | null;
  messageBody: string | null;
  chunkIds: string[] | null;
  createdAt: Date;
  context: { company: { id: string; name: string } | null; deal: { id: string; name: string; stage: string | null } | null };
  /** E2g: DECISION_ATTACHMENTS (null for non-send actions). */
  attachments: { assets: { id: string; title: string | null; sent: boolean }[]; removed: unknown[]; issues: unknown[] } | null;
  [key: string]: unknown;
}

export async function getDecision(db: Queryable, workspaceId: string, id: string) {
  const row = (
    await db.query<
      DecisionDetailRow & { _ownerName: string | null; _companyName: string; _emailOptOut: string; _whatsappOptOut: string; _whatsappBefore: boolean }
    >(
      `select d.id, d.created_at as "createdAt", d.mode, d.action, d.outcome, d.error, d.reasoning,
              d.message_subject as "messageSubject", d.message_body as "messageBody", d.asset_ids as "assetIds",
              d.send_at as "sendAt", d.next_wake_at as "nextWakeAt", d.handoff_title as "handoffTitle",
              d.handoff_urgency as "handoffUrgency", d.new_stage as "newStage", d.stop_reason as "stopReason",
              d.rules_result as "rulesResult", d.grounding_result as "groundingResult", d.regenerated, d.quality_checks as "qualityChecks",
              d.chunk_ids as "chunkIds", d.playbook_version as "playbookVersion", d.decision_model as "decisionModel",
              d.grounding_model as "groundingModel", d.input_tokens as "inputTokens", d.output_tokens as "outputTokens",
              d.cost_usd::float8 as "costUsd", d.rating, d.rating_reason as "ratingReason", d.rating_note as "ratingNote",
              d.rated_by as "ratedBy", rb.full_name as "ratedByName", d.rated_at as "ratedAt",
              d.lead_id as "leadId", json_build_object('id', l.id, 'name', ${LEAD_NAME}, 'company', l.company, 'ownerId', l.owner_id) as lead,
              d.send_status as "sendStatus", d.sent_at as "sentAt", d.send_error as "sendError", d.cancel_reason as "cancelReason",
              case d.action when 'send_email' then 'email' when 'send_whatsapp' then 'whatsapp' end as channel,
              d.stage_key as "stageKey", d.angle,
              ${DECISION_CONTEXT} as context, ${DECISION_ATTACHMENTS} as attachments,
              o.full_name as "_ownerName", coalesce(s.company_display_name, w.name) as "_companyName",
              s.email_opt_out_text as "_emailOptOut", s.whatsapp_opt_out_text as "_whatsappOptOut",
              -- The opt-out line goes on the first WhatsApp only: was one sent (or, in shadow, drafted and allowed) earlier?
              exists (select 1 from public.agent_decisions p
                       where p.lead_id = d.lead_id and p.workspace_id = d.workspace_id and p.action = 'send_whatsapp'
                         and (p.created_at, p.id) < (d.created_at, d.id)
                         and (p.outcome = 'sent' or (p.outcome = 'draft' and coalesce((p.rules_result ->> 'allowed')::boolean, false)))) as "_whatsappBefore"
         from public.agent_decisions d
         join public.leads l on l.id = d.lead_id
         join public.workspaces w on w.id = d.workspace_id
         join public.agent_settings s on s.workspace_id = d.workspace_id
         left join public.profiles o on o.id = l.owner_id
         left join public.profiles rb on rb.id = d.rated_by
         ${DECISION_CONTEXT_JOINS}
        where d.id = $1 and d.workspace_id = $2`,
      [id, workspaceId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Decision");
  const { _ownerName, _companyName, _emailOptOut, _whatsappOptOut, _whatsappBefore, ...decision } = row;

  let composed: OutgoingMessage | null = null;
  if ((decision.action === "send_email" || decision.action === "send_whatsapp") && decision.messageBody) {
    composed = composeOutgoing({ action: decision.action, subject: decision.messageSubject ?? "", body: decision.messageBody } as SendDecision, {
      ownerName: _ownerName ?? "The team",
      companyName: _companyName,
      settings: { email_opt_out_text: _emailOptOut, whatsapp_opt_out_text: _whatsappOptOut },
      isFirstWhatsApp: !_whatsappBefore,
    });
  }

  const [chunkRows, reports] = await Promise.all([
    decision.chunkIds?.length
      ? db.query<{ id: string; title: string; text: string }>(
          `select c.id, k.title, left(c.content, ${CHUNK_PREVIEW_CHARS}) as text
             from public.kb_chunks c join public.kb_documents k on k.id = c.document_id
            where c.id = any($1::uuid[]) and c.workspace_id = $2`,
          [decision.chunkIds, workspaceId],
        )
      : Promise.resolve({ rows: [] }),
    listReports(db, workspaceId, id),
  ]);
  const chunks = (decision.chunkIds ?? []).map((chunkId) => {
    const found = chunkRows.rows.find((c) => c.id === chunkId);
    return found ? { id: chunkId, deleted: false, title: found.title, text: found.text } : { id: chunkId, deleted: true, title: "deleted", text: "deleted" };
  });
  return { ...decision, composed, chunks, reports };
}

const listReports = async (db: Queryable, workspaceId: string, decisionId: string) =>
  (
    await db.query(
      `select r.id, r.decision_id as "decisionId", r.reported_by as "reportedBy", r.reported_by_name as "reportedByName", r.note,
              r.created_at as "createdAt", r.resolved_at as "resolvedAt", r.resolved_by as "resolvedBy",
              rb.full_name as "resolvedByName", r.resolution_note as "resolutionNote"
         from public.agent_decision_reports r left join public.profiles rb on rb.id = r.resolved_by
        where r.decision_id = $1 and r.workspace_id = $2
        order by r.created_at desc`,
      [decisionId, workspaceId],
    )
  ).rows;

export interface RatingInput {
  rating: "good" | "bad";
  reason?: RatingReason | undefined;
  note?: string | undefined;
}

/** Admins, or the lead's current owner. Re-rating overwrites. */
export async function rateDecision(db: Queryable, workspaceId: string, id: string, actor: Actor, input: RatingInput) {
  const row = (
    await db.query<{ outcome: string; owner_id: string | null }>(
      `select d.outcome, l.owner_id from public.agent_decisions d join public.leads l on l.id = d.lead_id
        where d.id = $1 and d.workspace_id = $2`,
      [id, workspaceId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Decision");
  if (actor.role !== "admin" && row.owner_id !== actor.id) throw new ForbiddenError("Only an admin or the lead's owner can rate this decision.");
  if (row.outcome === "failed") throw new InvalidTransitionError("A failed decision has nothing to rate.");
  if (input.rating === "bad" && !input.reason) throw new ValidationError("Choose a reason for a bad rating.");
  await db.query(
    `update public.agent_decisions
        set rating = $3, rating_reason = $4, rating_note = $5, rated_by = $6, rated_at = now()
      where id = $1 and workspace_id = $2`,
    [id, workspaceId, input.rating, input.rating === "bad" ? input.reason : null, input.note?.trim() || null, actor.id],
  );
  return getDecision(db, workspaceId, id);
}

/** Any CRM user. Notifies every active admin. Run inside a transaction. */
export async function reportProblem(db: Queryable, workspaceId: string, id: string, actor: Actor, note: string) {
  const decision = (
    await db.query<{ lead_id: string; lead_name: string }>(
      `select d.lead_id, ${LEAD_NAME} as lead_name from public.agent_decisions d join public.leads l on l.id = d.lead_id
        where d.id = $1 and d.workspace_id = $2`,
      [id, workspaceId],
    )
  ).rows[0];
  if (!decision) throw new NotFoundError("Decision");
  const report = (
    await db.query(
      `insert into public.agent_decision_reports (workspace_id, decision_id, reported_by, reported_by_name, note)
       values ($1, $2, $3, $4, $5)
       returning id, decision_id as "decisionId", reported_by as "reportedBy", reported_by_name as "reportedByName", note,
                 created_at as "createdAt", resolved_at as "resolvedAt", resolved_by as "resolvedBy", resolution_note as "resolutionNote"`,
      [workspaceId, id, actor.id, actor.fullName, note],
    )
  ).rows[0];
  await db.query(
    `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, lead_id, href)
     select $1, p.id, $2, $3, 'warning', $4, $5 from public.profiles p where p.role = 'admin' and p.is_active`,
    [workspaceId, `AI message reported on ${decision.lead_name}`.slice(0, 300), `${actor.fullName}: ${note}`.slice(0, REPORT_DETAIL_CHARS), decision.lead_id, `/leads/${decision.lead_id}`],
  );
  return report;
}

/** Admin only (the route guards it). */
export async function resolveReport(db: Queryable, workspaceId: string, id: string, actor: Actor, note?: string) {
  const resolved = (
    await db.query(
      `update public.agent_decision_reports
          set resolved_at = now(), resolved_by = $3, resolution_note = $4
        where id = $1 and workspace_id = $2 and resolved_at is null
        returning id, decision_id as "decisionId", reported_by as "reportedBy", reported_by_name as "reportedByName", note,
                  created_at as "createdAt", resolved_at as "resolvedAt", resolved_by as "resolvedBy", resolution_note as "resolutionNote"`,
      [id, workspaceId, actor.id, note?.trim() || null],
    )
  ).rows[0];
  if (resolved) return resolved;
  const exists = await db.query(`select 1 from public.agent_decision_reports where id = $1 and workspace_id = $2`, [id, workspaceId]);
  if (!exists.rowCount) throw new NotFoundError("Report");
  throw new ConflictError("This report is already resolved.");
}

/** Ratings for the go-live gate (failed decisions excluded; E2f: only decisions created since agent_settings.readiness_since). */
async function loadRatings(db: Queryable, workspaceId: string) {
  const rows = (
    await db.query<{ rating: "good" | "bad"; reason: RatingReason | null; n: number }>(
      `select rating, rating_reason as reason, count(*)::int as n from public.agent_decisions
        where workspace_id = $1 and outcome <> 'failed' and rating is not null
          and created_at >= coalesce((select readiness_since from public.agent_settings where workspace_id = $1), '-infinity')
        group by rating, rating_reason`,
      [workspaceId],
    )
  ).rows;
  const badByReason = Object.fromEntries(RATING_REASONS.map((r) => [r, 0])) as Record<RatingReason, number>;
  let good = 0;
  for (const { rating, reason, n } of rows) {
    if (rating === "good") good += n;
    else if (reason) badByReason[reason] += n;
  }
  return { good, badByReason };
}

export async function loadReadiness(db: Queryable, workspaceId: string): Promise<GoLiveReadiness> {
  return goLiveReadiness(await loadRatings(db, workspaceId));
}

// E3a rule 8: a decision that wrote a message: it was sent on, or the checks turned it into a handoff (which keeps the failed text).
const WROTE_MESSAGE = `(d.action in ('send_email', 'send_whatsapp') or (d.action = 'handoff' and d.message_body is not null))`;
const IS_SEND = `d.action in ('send_email', 'send_whatsapp')`;
const attemptSum = (field: string, value: string) => `coalesce(sum((select coalesce(sum(${value}), 0) from jsonb_array_elements(coalesce(d.quality_checks, '[]'::jsonb)) e where e ? '${field}')), 0)`;

/** The writing-quality numbers for decisions created since `$2` (failed decisions excluded). */
async function loadQuality(db: Queryable, workspaceId: string, since: Date | null) {
  const params = [workspaceId, since];
  const scope = `from public.agent_decisions d where d.workspace_id = $1 and d.outcome <> 'failed' and d.created_at >= coalesce($2::timestamptz, '-infinity')`;
  const [totals, handoffs] = await Promise.all([
    db.query<{ wrote: number; first: number; regenerated: number; auto_fixes: number; input: number; cached: number; avg_cost: number | null }>(
      `select count(*) filter (where ${WROTE_MESSAGE})::int as wrote,
              count(*) filter (where ${IS_SEND} and not d.regenerated)::int as first,
              count(*) filter (where ${IS_SEND} and d.regenerated)::int as regenerated,
              ${attemptSum("autoFixes", "jsonb_array_length(e -> 'autoFixes')")}::int as auto_fixes,
              ${attemptSum("inputTokens", "(e ->> 'inputTokens')::bigint")}::float8 as input,
              ${attemptSum("cachedInputTokens", "(e ->> 'cachedInputTokens')::bigint")}::float8 as cached,
              avg(d.cost_usd)::float8 as avg_cost
         ${scope}`,
      params,
    ),
    db.query<{ title: string; n: number }>(`select d.handoff_title as title, count(*)::int as n ${scope} and d.action = 'handoff' and d.message_body is not null group by 1 order by 2 desc, 1`, params),
  ]);
  const t = totals.rows[0]!;
  return {
    sendDecisions: t.wrote,
    passedFirstTry: t.first,
    passedFirstTryPct: t.wrote ? Math.round((t.first / t.wrote) * 100) : null,
    regenerated: t.regenerated,
    checkHandoffs: handoffs.rows.reduce((sum, h) => sum + h.n, 0),
    checkHandoffsByReason: Object.fromEntries(handoffs.rows.map((h) => [h.title, h.n])) as Record<string, number>,
    autoFixes: t.auto_fixes,
    avgCostUsd: t.avg_cost === null ? null : Math.round(t.avg_cost * 1e6) / 1e6,
    cachedInputPct: t.input ? Math.round((t.cached / t.input) * 100) : null,
  };
}

export async function getAgentStats(db: Queryable, workspaceId: string) {
  const readinessSince = (await db.query<{ readiness_since: Date | null }>(`select readiness_since from public.agent_settings where workspace_id = $1`, [workspaceId])).rows[0]?.readiness_since ?? null;
  const [counts, ratingCounts, openReports, spend, replies, live, qualitySinceReadiness, qualityLast7Days] = await Promise.all([
    db.query<{ action: string; outcome: string; n: number }>(
      `select action, outcome, count(*)::int as n from public.agent_decisions where workspace_id = $1 group by action, outcome`,
      [workspaceId],
    ),
    loadRatings(db, workspaceId),
    db.query<{ n: number }>(`select count(*)::int as n from public.agent_decision_reports where workspace_id = $1 and resolved_at is null`, [workspaceId]),
    db.query<{ spent: number; budget: number | null; month: string; mode: string | null }>(
      `select ${MONTH_SPEND_SQL}::float8 as spent,
              (select monthly_budget_usd::float8 from public.agent_settings where workspace_id = $1) as budget,
              (select mode from public.agent_settings where workspace_id = $1) as mode,
              to_char(${IST_MONTH}, 'YYYY-MM') as month`,
      [workspaceId],
    ),
    // D4a: replies (D3: WhatsApp + email) labelled this IST month, by label, and the AI cost of labelling them.
    db.query<{ label: string; n: number; cost: number }>(
      `select reply_label as label, count(*)::int as n, coalesce(sum(classification_cost_usd), 0)::float8 as cost
         from (select reply_label, classification_cost_usd, classified_at, workspace_id from public.whatsapp_inbound_events
               union all
               select reply_label, classification_cost_usd, classified_at, workspace_id from public.email_inbound_events) r
        where workspace_id = $1 and reply_label is not null and classified_at >= (${IST_MONTH} at time zone 'Asia/Kolkata')
        group by reply_label`,
      [workspaceId],
    ),
    // E2: the live scope and real AI sends.
    db.query<{
      scope: LiveScope;
      live_since: Date | null;
      readiness_since: Date | null;
      live_contacts: number;
      sent_today: number;
      sent_month: number;
      banned_phrases: string[];
      style_examples: string;
      email_max_words: number;
      whatsapp_max_words: number;
    }>(
      `select s.live_scope as scope, s.live_since, s.readiness_since, s.banned_phrases, s.style_examples, s.email_max_words, s.whatsapp_max_words,
              case when s.mode = 'live' then (select count(*)::int from public.leads l where l.workspace_id = s.workspace_id and ${liveContactSql("s.live_scope", "s.live_since")}) else 0 end as live_contacts,
              (select count(*)::int from public.agent_decisions where workspace_id = s.workspace_id and send_status = 'sent'
                and sent_at >= (${IST_DAY} at time zone 'Asia/Kolkata')) as sent_today,
              (select count(*)::int from public.agent_decisions where workspace_id = s.workspace_id and send_status = 'sent'
                and sent_at >= (${IST_MONTH} at time zone 'Asia/Kolkata')) as sent_month
         from public.agent_settings s where s.workspace_id = $1`,
      [workspaceId],
    ),
    loadQuality(db, workspaceId, readinessSince),
    loadQuality(db, workspaceId, new Date(Date.now() - 7 * 24 * 3_600_000)),
  ]);

  const byAction: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  let failed = 0;
  for (const { action, outcome, n } of counts.rows) {
    if (outcome === "failed") {
      failed += n;
      continue;
    }
    byAction[action] = (byAction[action] ?? 0) + n;
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + n;
  }
  const { good, badByReason } = ratingCounts;
  const bad = Object.values(badByReason).reduce((a, b) => a + b, 0);
  const s = spend.rows[0]!;
  return {
    // The agent mode, so every CRM user (not only admins, who can read the settings) sees it.
    mode: s.mode,
    byAction,
    byOutcome,
    failed,
    ratings: { rated: good + bad, good, bad, badByReason },
    openReports: openReports.rows[0]!.n,
    spend: { month: s.month, spentUsd: s.spent, budgetUsd: s.budget },
    replies: {
      byLabel: Object.fromEntries(replies.rows.map((r) => [r.label, r.n])) as Record<string, number>,
      costUsd: Math.round(replies.rows.reduce((sum, r) => sum + r.cost, 0) * 1e6) / 1e6,
    },
    readiness: goLiveReadiness({ good, badByReason }),
    // E2f: ratings (and readiness) count decisions created since this time; null = all time.
    readinessSince: live.rows[0]?.readiness_since?.toISOString() ?? null,
    live: live.rows[0]
      ? {
          scope: live.rows[0].scope,
          liveSince: live.rows[0].live_since?.toISOString() ?? null,
          liveContacts: live.rows[0].live_contacts,
          sentToday: live.rows[0].sent_today,
          sentThisMonth: live.rows[0].sent_month,
        }
      : null,
    // E3a rule 8: how the writer does against the checks.
    quality: { sinceReadiness: qualitySinceReadiness, last7Days: qualityLast7Days },
    // E2b: the writing rules, read-only for every CRM user (settings are admin-only).
    messageRules: live.rows[0]
      ? { bannedPhrases: live.rows[0].banned_phrases, emailMaxWords: live.rows[0].email_max_words, whatsappMaxWords: live.rows[0].whatsapp_max_words, styleExamples: live.rows[0].style_examples }
      : null,
  };
}

export async function getLeadAgentPanel(db: Queryable, workspaceId: string, leadId: string) {
  const row = (
    await db.query<{ _createdAt: Date; _mode: "off" | "shadow" | "live"; _scope: LiveScope; _since: Date | null; liveTest: boolean; [key: string]: unknown }>(
      `select l.id as "leadId", l.agent_status as status, l.agent_status_reason as "statusReason", l.agent_status_changed_at as "statusChangedAt",
              l.agent_touch_count as "touchCount", l.agent_last_touch_at as "lastTouchAt", l.agent_live_test as "liveTest",
              l.created_at as "_createdAt", s.mode as "_mode", s.live_scope as "_scope", s.live_since as "_since"
         from public.leads l join public.agent_settings s on s.workspace_id = l.workspace_id
        where l.id = $1 and l.workspace_id = $2`,
      [leadId, workspaceId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Lead");
  const { _createdAt, _mode, _scope, _since, ...lead } = row;
  // E2 rule 2: whether this contact runs live or as shadow (off when the agent is off).
  const mode = effectiveMode({ mode: _mode, live_scope: _scope, live_since: _since }, { agentLiveTest: row.liveTest, createdAt: _createdAt });
  const [wakeup, decisions] = await Promise.all([
    db.query(
      `select id, due_at as "dueAt", reason from public.agent_wakeups
        where lead_id = $1 and workspace_id = $2 and status = 'pending' order by due_at limit 1`,
      [leadId, workspaceId],
    ),
    db.query(
      `select d.id, d.created_at as "createdAt", d.mode, d.action, d.outcome, d.reasoning, d.message_subject as "messageSubject",
              d.message_body as "messageBody", d.send_at as "sendAt", d.handoff_title as "handoffTitle", d.new_stage as "newStage",
              d.stop_reason as "stopReason", d.regenerated, d.error, ${SEND_COLUMNS},
              case when d.rules_result is null then null else json_build_object(
                'allowed', d.rules_result -> 'allowed', 'outcome', d.rules_result -> 'outcome',
                'violations', d.rules_result -> 'violations', 'adjustments', d.rules_result -> 'adjustments') end as rules,
              case when d.grounding_result is null then null else json_build_object(
                'supported', d.grounding_result -> 'supported', 'unsupportedClaims', d.grounding_result -> 'unsupportedClaims',
                'styleViolations', d.grounding_result -> 'styleViolations') end as grounding,
              d.rating, d.rating_reason as "ratingReason", d.rating_note as "ratingNote", ${OPEN_REPORTS} as "openReports",
              ${DECISION_CONTEXT} as context, ${DECISION_ATTACHMENTS} as attachments
         from public.agent_decisions d
         ${DECISION_CONTEXT_JOINS}
        where d.lead_id = $1 and d.workspace_id = $2
        order by d.created_at desc, d.id desc limit ${PANEL_DECISIONS}`,
      [leadId, workspaceId],
    ),
  ]);
  return { ...lead, effectiveMode: mode, nextWakeup: wakeup.rows[0] ?? null, decisions: decisions.rows };
}
