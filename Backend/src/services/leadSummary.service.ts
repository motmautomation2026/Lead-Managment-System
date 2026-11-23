/**
 * SUM-1: the lead summary card. Quick facts (no AI, read on request) + the worker's AI summary (lead_summaries).
 * Every SQL query of the feature lives here; the prompt, hash and rules are pure in agent/leadSummary.ts.
 * Queueing: every timeline event marks the row due in 2 min (migration 064 trigger); the worker summarises only
 * automated leads (AUTOMATED_SQL) or leads someone opened while the summary was missing / stale. No OpenAI call in
 * a request. The summary text is never logged, never sent to the lead and never put into the writer prompt.
 */
import { pool, withTransaction } from "../db.js";
import { env } from "../env.js";
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { AppError, ForbiddenError } from "../errors.js";
import { costUsd, parsePrices, priceOf, type ModelPrices } from "../agent/pricing.js";
import { effectiveMode } from "../agent/liveMode.js";
import type { AgentMode } from "../agent/rules.js";
import {
  buildLeadSummaryMessages,
  clip,
  isStale,
  LEAD_SUMMARY_JSON_SCHEMA,
  refreshWaitMs,
  summaryInputHash,
  summaryModel,
  SUMMARY_TIMELINE_LIMIT,
  type LeadSummary,
  type SummaryInput,
  type SummaryStatus,
} from "../agent/leadSummary.js";
import { resolveAgentModels, type LeadSummaryModel } from "../providers/openai.provider.js";
import { PermanentProviderError, ProviderDeferredError } from "../providers/provider-errors.js";
import { getLeadRowOr404 } from "./leads.service.js";
import { AUTOMATED_SQL } from "./leadAutomation.service.js";
import { MONTH_SPEND_SQL } from "./agentRunner.service.js";
import { WEBSITE_TITLES } from "./agentContext.service.js";
import { fairPickSql } from "./fairPick.js";

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 3;
const MINUTE = 60_000;
const IST_DAY = `date_trunc('day', now() at time zone 'Asia/Kolkata')`;
/** Rule 5: today's (IST) AI summaries of workspace $1. */
export const SUMMARIES_TODAY_SQL = `(select count(*)::int from public.lead_summary_runs
     where workspace_id = $1 and created_at >= (${IST_DAY} at time zone 'Asia/Kolkata'))`;
const IST_DATE = (col: string) => `to_char(${col} at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`;
const TIMELINE_KINDS = ["call", "note", "meeting", "proposal", "stage", "email", "whatsapp", "automation", "deal"];
const LIFECYCLE_TITLES = ["Won", "Lost", "Discarded", "Do Not Contact", "Moved to Long-Term Nurture", "Reactivated", "Merged"];
const PLAIN_CHANNEL = ["valid", "reachable", "delivered"];

// --- Quick facts (rule 3, no AI) ------------------------------------------------

export interface QuickFacts {
  requirement: string | null;
  lastCall: { at: string; connected: boolean; outcome: string } | null;
  lastMessage: { at: string; channel: string; source: string } | null;
  lastReply: { at: string; channel: string; label: string | null } | null;
  nextStep: { kind: "task" | "meeting"; title: string; at: string } | null;
}

interface FactsRow {
  requirement: string | null;
  service_interest: string | null;
  call: { at: string; connected: boolean; outcome: string } | null;
  message: { at: string; channel: string; source: string } | null;
  replies: { at: string; channel: string; label: string | null }[] | null;
  task: { title: string; at: string } | null;
  meeting: { title: string; at: string } | null;
}

async function loadFacts(db: Queryable, workspaceId: string, leadId: string, replyLimit: number): Promise<FactsRow> {
  return (
    await db.query<FactsRow>(
      `select (select t.metadata ->> 'rawMessage' from public.timeline_events t
                where t.lead_id = l.id and t.title = any($3::text[]) and t.metadata ? 'rawMessage'
                order by t.occurred_at desc limit 1) as requirement,
              l.service_interest,
              (select json_build_object('at', c.created_at, 'connected', c.connected,
                        'outcome', coalesce(c.connected_outcome::text, c.not_connected_reason::text))
                 from public.calls c where c.lead_id = l.id and c.workspace_id = l.workspace_id
                order by c.created_at desc limit 1) as call,
              (select json_build_object('at', f.sent_at, 'channel', f.channel, 'source', f.source)
                 from public.message_facts f where f.lead_id = l.id and f.workspace_id = l.workspace_id
                order by f.sent_at desc limit 1) as message,
              -- Replies: date, channel and the D4a label only, never the text.
              (select json_agg(r order by r.at desc) from (
                 (select w.received_at as at, 'whatsapp' as channel, w.reply_label as label from public.whatsapp_inbound_events w
                   where w.lead_id = l.id and w.workspace_id = l.workspace_id and w.disposition = 'matched'
                   order by w.received_at desc limit $4)
                 union all
                 (select e.received_at, 'email', e.reply_label from public.email_inbound_events e
                   where e.lead_id = l.id and e.workspace_id = l.workspace_id and e.kind = 'reply'
                   order by e.received_at desc limit $4)
                 order by at desc limit $4) r) as replies,
              (select json_build_object('title', n.title, 'at', n.due_at) from public.lead_next_actions n where n.lead_id = l.id) as task,
              (select json_build_object('title', m.title, 'at', m.scheduled_at) from public.meetings m
                where m.lead_id = l.id and m.workspace_id = l.workspace_id and m.scheduled_at > now()
                  and m.status in ('tentative', 'scheduled', 'confirmed', 'rescheduled')
                order by m.scheduled_at limit 1) as meeting
         from public.leads l where l.id = $1 and l.workspace_id = $2`,
      [leadId, workspaceId, WEBSITE_TITLES, replyLimit],
    )
  ).rows[0]!;
}

const nextStepOf = (f: FactsRow): QuickFacts["nextStep"] => {
  const task = f.task ? { kind: "task" as const, ...f.task } : null;
  const meeting = f.meeting ? { kind: "meeting" as const, ...f.meeting } : null;
  if (task && meeting) return new Date(meeting.at) < new Date(task.at) ? meeting : task;
  return task ?? meeting;
};

export function quickFactsOf(f: FactsRow): QuickFacts {
  return {
    requirement: clip(f.requirement, 600) || f.service_interest || null,
    lastCall: f.call,
    lastMessage: f.message,
    lastReply: f.replies?.[0] ?? null,
    nextStep: nextStepOf(f),
  };
}

// --- The card (GET) and Refresh (POST) -----------------------------------------

interface SummaryRow {
  activity_at: Date;
  checked_at: Date | null;
  due_at: Date | null;
  summary: LeadSummary | null;
  generated_at: Date | null;
  status: SummaryStatus | null;
  refresh_requested_at: Date | null;
}

const canRefresh = (actor: Actor, ownerId: string | null) => actor.role === "admin" || ownerId === actor.id;

/**
 * GET /leads/:id/summary: same visibility as the lead (workspace members). A missing or stale summary is queued
 * for the worker (rule 4: old leads are summarised only when someone opens them).
 */
export async function getLeadSummary(db: Queryable, actor: Actor, workspaceId: string, leadId: string, now = new Date()) {
  const lead = await getLeadRowOr404(db, workspaceId, leadId);
  const facts = quickFactsOf(await loadFacts(db, workspaceId, leadId, 1));
  let row = (
    await db.query<SummaryRow>(
      `select activity_at, checked_at, due_at, summary, generated_at, status, refresh_requested_at from public.lead_summaries where lead_id = $1`,
      [leadId],
    )
  ).rows[0] ?? null;
  if (isStale(row) && !row?.due_at) {
    row = (
      await db.query<SummaryRow>(
        `insert into public.lead_summaries as s (lead_id, workspace_id, activity_at, due_at, opened_at)
         values ($1, $2, coalesce((select max(t.occurred_at) from public.timeline_events t where t.lead_id = $1), now()), now(), now())
         on conflict (lead_id) do update set due_at = now(), opened_at = now(), updated_at = now()
         returning activity_at, checked_at, due_at, summary, generated_at, status, refresh_requested_at`,
        [leadId, workspaceId],
      )
    ).rows[0]!;
  }
  const wait = refreshWaitMs(row?.refresh_requested_at ?? null, now);
  return {
    quickFacts: facts,
    ai: {
      summary: row?.summary ?? null,
      generatedAt: row?.generated_at?.toISOString() ?? null,
      status: row?.status ?? null,
      pending: Boolean(row?.due_at),
    },
    canRefresh: canRefresh(actor, lead.owner_id),
    refreshAvailableAt: wait ? new Date(now.getTime() + wait).toISOString() : null,
  };
}

/** POST /leads/:id/summary/refresh: admin or the owner; queues a forced summary, once per 5 minutes per lead. */
export async function refreshLeadSummary(actor: Actor, workspaceId: string, leadId: string, now = new Date()) {
  return withTransaction(async (client) => {
    const lead = await getLeadRowOr404(client, workspaceId, leadId);
    if (!canRefresh(actor, lead.owner_id)) throw new ForbiddenError("Only an admin or the contact's owner can refresh the summary.");
    await client.query(
      `insert into public.lead_summaries (lead_id, workspace_id, activity_at)
       values ($1, $2, coalesce((select max(t.occurred_at) from public.timeline_events t where t.lead_id = $1), now()))
       on conflict (lead_id) do nothing`,
      [leadId, workspaceId],
    );
    const last = (await client.query<{ at: Date | null }>(`select refresh_requested_at as at from public.lead_summaries where lead_id = $1 for update`, [leadId])).rows[0]!.at;
    const wait = refreshWaitMs(last, now);
    if (wait) throw new AppError(429, "rate_limited", `The summary was refreshed recently. Try again in ${Math.ceil(wait / MINUTE)} min.`);
    await client.query(
      `update public.lead_summaries set force = true, opened_at = now(), due_at = now(), refresh_requested_at = $2, updated_at = now() where lead_id = $1`,
      [leadId, now],
    );
    return { queued: true };
  });
}

// --- The model input ------------------------------------------------------------

interface InputLeadRow {
  service_interest: string | null;
  company: string | null;
  company_name: string | null;
  industry: string | null;
  source: string;
  lifecycle_state: string;
  pipeline_stage: string;
  hot_band: string | null;
  agent_status: string;
  agent_status_reason: string | null;
  agent_live_test: boolean;
  automated: boolean;
  mode: AgentMode;
  live_scope: "test_contacts" | "new_leads" | "all";
  live_since: Date | null;
  channels: { channel: string; status: string }[] | null;
  deals: { name: string; stage: string }[] | null;
}

/** The facts the model sees (rule 2): CRM data only, replies as labels, never reply text. */
export async function loadSummaryInput(db: Queryable, workspaceId: string, leadId: string): Promise<SummaryInput> {
  const [lead, facts, timeline] = await Promise.all([
    db.query<InputLeadRow>(
      `select l.service_interest, l.company, c.name as company_name, coalesce(l.industry, c.industry) as industry, l.source::text as source,
              l.lifecycle_state::text as lifecycle_state, l.pipeline_stage::text as pipeline_stage, l.hot_band, l.agent_status::text as agent_status,
              l.agent_status_reason, l.agent_live_test, ${AUTOMATED_SQL("l")} as automated,
              s.mode, s.live_scope, s.live_since,
              (select json_agg(json_build_object('channel', ch.channel, 'status', ch.status) order by ch.channel)
                 from public.lead_contact_channels ch where ch.lead_id = l.id and not (ch.status = any($3::text[]))) as channels,
              (select json_agg(json_build_object('name', d.name, 'stage', d.stage) order by d.created_at)
                 from public.deals d where d.lead_id = l.id and d.workspace_id = l.workspace_id) as deals
         from public.leads l
         join public.agent_settings s on s.workspace_id = l.workspace_id
         left join public.companies c on c.id = l.company_id and c.workspace_id = l.workspace_id
        where l.id = $1 and l.workspace_id = $2`,
      [leadId, workspaceId, PLAIN_CHANNEL],
    ),
    loadFacts(db, workspaceId, leadId, 5),
    db.query<{ at: string; kind: string; title: string; detail: string | null }>(
      `select ${IST_DATE("t.occurred_at")} as at, t.event_kind as kind, t.title, t.detail
         from public.timeline_events t join public.leads l on l.id = t.lead_id
        where t.lead_id = $1 and l.workspace_id = $2
          and (t.event_kind = any($3::text[]) or (t.event_kind = 'system' and t.title = any($4::text[])))
        order by t.occurred_at desc, t.id desc limit $5`,
      [leadId, workspaceId, TIMELINE_KINDS, LIFECYCLE_TITLES, SUMMARY_TIMELINE_LIMIT],
    ),
  ]);
  const l = lead.rows[0]!;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const quick = quickFactsOf(facts);
  return {
    requirement: quick.requirement,
    serviceInterest: l.service_interest,
    company: l.company_name ?? l.company,
    industry: l.industry,
    source: l.source,
    lifecycle: l.lifecycle_state,
    stage: l.pipeline_stage,
    hotBand: l.hot_band,
    aiMode: effectiveMode(l, { automated: l.automated, agentLiveTest: l.agent_live_test }),
    aiStatus: l.agent_status,
    aiStatusReason: l.agent_status_reason,
    doNotContact: l.lifecycle_state === "do_not_contact",
    channelProblems: l.channels ?? [],
    deals: l.deals ?? [],
    nextStep: quick.nextStep ? { ...quick.nextStep, at: day(quick.nextStep.at) } : null,
    replies: (facts.replies ?? []).map((r) => ({ at: day(r.at), channel: r.channel, label: r.label })),
    timeline: timeline.rows.map((t) => ({ at: t.at, kind: t.kind, title: clip(t.title), detail: clip(t.detail) || null })),
  };
}

// --- The worker (rules 3–5) --------------------------------------------------------

export interface LeadSummaryDeps {
  model: LeadSummaryModel;
  /** Default: OPENAI_PRICES_JSON. */
  prices?: ModelPrices;
  /** Default: OPENAI_DECISION_MODEL / OPENAI_GROUNDING_MODEL (the writer summarises). */
  defaultModels?: { decision?: string | undefined; grounding?: string | undefined };
  /** Tests: only these workspaces. */
  workspaceIds?: string[];
}

interface Claimed {
  lead_id: string;
  workspace_id: string;
  force: boolean;
  input_hash: string | null;
  has_summary: boolean;
  attempts: number;
  claimed_at: Date;
}

export interface SummaryOutcome {
  leadId: string;
  result: "generated" | "unchanged" | "off" | "paused_cap" | "paused_budget" | "deferred" | "retry" | "failed";
}

/** Drops due rows the worker must not summarise: not automated and not opened / refreshed (old leads only on open). */
const PRUNE_SQL = `update public.lead_summaries s set due_at = null, updated_at = now()
   where s.lead_id in (
     select x.lead_id from public.lead_summaries x
       join public.leads l on l.id = x.lead_id and l.workspace_id = x.workspace_id
      where x.due_at <= now() and x.opened_at is null and not x.force
        and ($1::uuid[] is null or x.workspace_id = any($1::uuid[]))
        and (l.merged_into_lead_id is not null or not ${AUTOMATED_SQL("l")})
      limit 500)`;

/** Claims up to 10 due summaries (round-robin across workspaces) and writes them one at a time. No-op unless `enabled`. */
export async function runLeadSummaries(enabled: boolean, deps: LeadSummaryDeps): Promise<SummaryOutcome[]> {
  if (!enabled) return [];
  const ws = deps.workspaceIds ?? null;
  await pool.query(PRUNE_SQL, [ws]);
  const claimed = (
    await pool.query<Claimed>(
      `update public.lead_summaries s
          set due_at = now() + interval '15 minutes', attempts = s.attempts + 1, updated_at = now()
        where s.lead_id in (
          select x.lead_id from public.lead_summaries x
           where x.lead_id in (${fairPickSql({
             from: "public.lead_summaries x",
             // Rule 4: at most one automatic summary per lead per 10 minutes (Refresh skips it).
             where: "x.due_at <= now() and (x.force or x.generated_at is null or x.generated_at <= now() - interval '10 minutes') and ($1::uuid[] is null or x.workspace_id = any($1::uuid[]))",
             order: "x.due_at",
             limit: "$2",
             key: "x.lead_id",
           })})
             and x.due_at <= now()
           for update skip locked)
        returning s.lead_id, s.workspace_id, s.force, s.input_hash, s.summary is not null as has_summary, s.attempts, now() as claimed_at`,
      [ws, BATCH_SIZE],
    )
  ).rows;
  const outcomes: SummaryOutcome[] = [];
  for (const row of claimed) outcomes.push(await summarise(row, deps));
  return outcomes;
}

/** Ends a claim: clears the queue unless new activity came in meanwhile (the trigger's debounce then stands). */
async function finish(row: Claimed, set: string, params: unknown[] = []) {
  await pool.query(
    `update public.lead_summaries
        set ${set ? `${set}, ` : ""}attempts = 0, force = false, opened_at = null, updated_at = now(),
            due_at = case when activity_at > $2 then due_at else null end
      where lead_id = $1`,
    [row.lead_id, row.claimed_at, ...params],
  );
}

async function retryIn(row: Claimed, ms: number, restoreAttempt: boolean, error: string | null = null) {
  await pool.query(
    `update public.lead_summaries set due_at = now() + $2 * interval '1 millisecond', attempts = attempts - $3, last_error = $4, updated_at = now() where lead_id = $1`,
    [row.lead_id, ms, restoreAttempt ? 1 : 0, error],
  );
}

async function summarise(row: Claimed, deps: LeadSummaryDeps): Promise<SummaryOutcome> {
  const base = { leadId: row.lead_id };
  const state = (
    await pool.query<{ mode: AgentMode; decision_model: string | null; grounding_model: string | null; budget: string; cap: number; spent: string; today: number }>(
      `select s.mode, s.decision_model, s.grounding_model, s.monthly_budget_usd as budget, s.summary_daily_cap as cap,
              ${MONTH_SPEND_SQL} as spent, ${SUMMARIES_TODAY_SQL} as today
         from public.agent_settings s where s.workspace_id = $1`,
      [row.workspace_id],
    )
  ).rows[0];
  // Rule 5 + the reply classifier's precedent: no AI when the agent is off, the month's budget or today's cap is used.
  const stop: SummaryStatus | null = !state || state.mode === "off" ? "off" : Number(state.spent) >= Number(state.budget) ? "paused_budget" : state.today >= state.cap ? "paused_cap" : null;
  if (stop) {
    await finish(row, "status = $3", [stop]);
    return { ...base, result: stop };
  }

  let input: SummaryInput;
  try {
    input = await loadSummaryInput(pool, row.workspace_id, row.lead_id);
  } catch (error) {
    await retryIn(row, 5 * MINUTE, false, error instanceof Error ? error.name : "error");
    return { ...base, result: "retry" };
  }
  const hash = summaryInputHash(input);
  if (!row.force && row.has_summary && hash === row.input_hash) {
    await finish(row, "checked_at = now(), status = 'ready', last_error = null");
    return { ...base, result: "unchanged" };
  }

  const prices = deps.prices ?? parsePrices(env.OPENAI_PRICES_JSON);
  let model: string;
  try {
    model = summaryModel(resolveAgentModels(state!, deps.defaultModels).decisionModel);
  } catch {
    await retryIn(row, 10 * MINUTE, true, "no_model");
    return { ...base, result: "deferred" };
  }
  if (!priceOf(prices, model)) {
    console.warn(`[summary] No price in OPENAI_PRICES_JSON for ${model}; lead summaries deferred 10 min.`);
    await retryIn(row, 10 * MINUTE, true, "no_price");
    return { ...base, result: "deferred" };
  }

  try {
    const result = await deps.model.summarizeLead({
      model,
      messages: buildLeadSummaryMessages(input),
      jsonSchema: { name: "lead_summary", schema: LEAD_SUMMARY_JSON_SCHEMA as unknown as Record<string, unknown> },
    });
    const cost = costUsd(prices, model, result.inputTokens, result.outputTokens, result.cachedInputTokens);
    await withTransaction(async (client) => {
      await client.query(
        `insert into public.lead_summary_runs (workspace_id, lead_id, model, input_tokens, output_tokens, cost_usd) values ($1, $2, $3, $4, $5, $6)`,
        [row.workspace_id, row.lead_id, model, result.inputTokens, result.outputTokens, cost],
      );
    });
    await finish(row, "summary = $3, input_hash = $4, model = $5, generated_at = now(), checked_at = now(), status = 'ready', last_error = null", [JSON.stringify(result.json), hash, model]);
    // Never the summary text: ids, tokens and cost only.
    console.log(`[summary] lead ${row.lead_id}: tokens ${result.inputTokens}/${result.outputTokens}, cost $${(cost ?? 0).toFixed(6)}.`);
    return { ...base, result: "generated" };
  } catch (error) {
    if (error instanceof ProviderDeferredError) {
      await retryIn(row, error.retryAfterMs || 10 * MINUTE, true, error.name);
      return { ...base, result: "deferred" };
    }
    const name = error instanceof Error ? error.name : "error";
    if (error instanceof PermanentProviderError || row.attempts >= MAX_ATTEMPTS) {
      console.warn(`[summary] lead ${row.lead_id}: failed after attempt ${row.attempts} (${name}).`);
      await finish(row, "status = 'failed', checked_at = now(), last_error = $3", [name]);
      return { ...base, result: "failed" };
    }
    await retryIn(row, MINUTE * 2 ** (row.attempts - 1), false, name);
    return { ...base, result: "retry" };
  }
}
