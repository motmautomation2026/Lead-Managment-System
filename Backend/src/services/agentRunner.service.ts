import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { env } from "../env.js";
import { AGENT_ACTOR_NAME } from "../agent/constants.js";
import { DECISION_JSON_SCHEMA, type AgentDecision } from "../agent/decisionSchema.js";
import { costUsd, parsePrices, priceOf, type ModelPrices } from "../agent/pricing.js";
import { applyGroundingAllowList, buildDecisionMessages, buildGroundingMessages, GROUNDING_JSON_SCHEMA, STYLE_RULES, type GroundingResult } from "../agent/prompt.js";
import { checkMessage, messageFactsOf } from "../agent/messageChecks.js";
import { polishDecision, type AutoFix } from "../agent/polish.js";
import { precheck, validateDecision, type RulesResult } from "../agent/rules.js";
import type { DecisionModel, Embedder, ModelCallResult } from "../providers/openai.provider.js";
import { resolveAgentModels } from "../providers/openai.provider.js";
import { PermanentProviderError, ProviderDeferredError } from "../providers/provider-errors.js";
import { buildAgentContext, type AgentContext, type AgentSettingsRow } from "./agentContext.service.js";
import { enqueueWakeup } from "./agentWakeups.service.js";
import { addTimelineEvent } from "./timeline.service.js";
import { composeOutgoing } from "../agent/composeMessage.js";
import { executeHandoff, executeStageChange, executeStop } from "./agentSends.service.js";
import { enqueueEmail, type AttachmentRef } from "./emailOutbound.service.js";
import { attachmentFileName } from "../agent/assetRules.js";
import { AGENT_ASSETS_BUCKET } from "./knowledgeLibrary.service.js";

/**
 * The agent's decision loop (3C-2): turns due wakeups into agent_decisions. A shadow
 * contact gets a DRAFT (nothing sent, no task, no stage/status change). E2: a live
 * contact's allowed send is queued (sent later by the worker's channel queues, after a
 * re-check), and handoff / stop / update_stage are executed in the decision's
 * transaction. No transaction or checked-out client is held during model calls.
 */

const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 3;
const MINUTE = 60_000;
const CONFIG_RETRY_MS = 10 * MINUTE;
const PLAYBOOK_RETRY_MS = 60 * MINUTE;
const BUDGET_RETRY_MS = 60 * MINUTE;
const FAILURE_RETRY_MS = 5 * MINUTE;
const HANDOFF_TITLE = "AI couldn't write a safe message";
const QUESTION_HANDOFF_TITLE = "AI couldn't write a one-question message";
const PLAYBOOK_HANDOFF_TITLE = "AI couldn't write a message that meets the playbook";
const QUESTION_RULE = "one_question";
// Problems that are about the playbook's writing rules (E2b), not safety or facts.
// internal_info_leak is a safety problem, not a playbook one ("AI couldn't write a safe message").
const PLAYBOOK_RULES = ["banned_phrase", "length", QUESTION_RULE, "compound_question", "exclamation", "not_thanking_inbound", "attachment_mention", "subject_style", "contact_details", ...STYLE_RULES];
const ruleOf = (problem: string) => problem.slice(0, problem.indexOf(":"));
// E2f rule 7: code-checked writing problems a rewrite reliably fixes; only these earn a second regeneration.
const FIXABLE_RULES = [QUESTION_RULE, "compound_question", "banned_phrase", "length", "exclamation", "not_thanking_inbound", "introduction_mid_conversation", "attachment_mention", "subject_style", "contact_details", "content_contacts"];
// Grounding only runs when the code checks pass, so a grounded attempt (unsupported claim / style) is never "fixable only".
const fixableOnly = (a: DraftAttempt) => !a.grounding && a.rules.violations.length > 0 && a.rules.violations.every((v) => FIXABLE_RULES.includes(v.rule));
const SHADOW_NOTE = "Shadow mode — not sent";
const AGENT_ACTOR = { actorId: null, actorName: AGENT_ACTOR_NAME, actorSource: "automation" as const };
export const IST_MONTH = `date_trunc('month', now() at time zone 'Asia/Kolkata')`;
const IST_DAY = `date_trunc('day', now() at time zone 'Asia/Kolkata')`;
/** This IST month's AI spend of workspace $1: decisions plus reply classifications (D4a). */
export const MONTH_SPEND_SQL = `(coalesce((select sum(cost_usd) from public.agent_decisions
     where workspace_id = $1 and created_at >= (${IST_MONTH} at time zone 'Asia/Kolkata')), 0)
   + coalesce((select sum(classification_cost_usd) from public.whatsapp_inbound_events
     where workspace_id = $1 and classified_at >= (${IST_MONTH} at time zone 'Asia/Kolkata')), 0)
   + coalesce((select sum(classification_cost_usd) from public.email_inbound_events
     where workspace_id = $1 and classified_at >= (${IST_MONTH} at time zone 'Asia/Kolkata')), 0))`;

export interface AgentRunnerDeps {
  model: DecisionModel;
  embedder: Embedder;
  /** Default: OPENAI_PRICES_JSON. */
  prices?: ModelPrices;
  /** Default: OPENAI_DECISION_MODEL / OPENAI_GROUNDING_MODEL. */
  defaultModels?: { decision?: string | undefined; grounding?: string | undefined };
  /** Tests: only claim wakeups in these workspaces. */
  workspaceIds?: string[];
}

// --- The decision pipeline (no DB; shared with scripts/agent-preview.ts) ---------

export interface Usage {
  inputTokens: number;
  /** The part of inputTokens served from OpenAI's prompt cache (E3a). */
  cachedInputTokens?: number;
  outputTokens: number;
  costUsd: number;
}

export interface DraftAttempt {
  /** E3a: input tokens of this attempt's model calls and the cached part (decide + grounding). */
  tokens: { input: number; cached: number };
  /** E3a rule 3: what code fixed on this attempt's text (before the checks). */
  autoFixes: AutoFix[];
  decision: AgentDecision;
  rules: RulesResult;
  grounding: GroundingResult | null;
  /** Rule violations and unsupported claims; empty = passed. */
  problems: string[];
}

export interface DraftResult {
  /** What gets recorded: the passing attempt's final decision, or the handoff fallback. */
  decision: AgentDecision;
  rules: RulesResult;
  grounding: GroundingResult | null;
  outcome: "draft" | "blocked";
  regenerated: boolean;
  /** The failed attempt whose message is kept on a handoff fallback. */
  failedAttempt: DraftAttempt | null;
  attempts: DraftAttempt[];
}

const isSend = (d: AgentDecision): d is Extract<AgentDecision, { action: "send_email" | "send_whatsapp" }> =>
  d.action === "send_email" || d.action === "send_whatsapp";

/**
 * decide → validate → ground (allowed sends) → regenerate on problems (once; twice while the
 * latest attempt failed only fixable code checks, E2f rule 7) → handoff fallback. `usage`
 * accumulates over every call, including ones before a thrown error.
 */
export async function draftDecision(
  ctx: AgentContext,
  deps: { model: DecisionModel; decisionModel: string; groundingModel: string; prices: ModelPrices; now: Date },
  usage: Usage,
): Promise<DraftResult> {
  const add = (modelName: string, result: ModelCallResult<unknown>, tokens: DraftAttempt["tokens"]) => {
    const cached = result.cachedInputTokens ?? 0;
    usage.inputTokens += result.inputTokens;
    usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + cached;
    usage.outputTokens += result.outputTokens;
    usage.costUsd += costUsd(deps.prices, modelName, result.inputTokens, result.outputTokens, cached) ?? 0;
    tokens.input += result.inputTokens;
    tokens.cached += cached;
  };

  const attempt = async (problems?: string[]): Promise<DraftAttempt> => {
    const tokens = { input: 0, cached: 0 };
    const messages = buildDecisionMessages(ctx, ctx.settings, deps.now, problems ? { previousFailure: { problems } } : {});
    const decided = await deps.model.decide({ model: deps.decisionModel, messages, jsonSchema: { name: "agent_decision", schema: DECISION_JSON_SCHEMA as unknown as Record<string, unknown> } });
    add(deps.decisionModel, decided, tokens);
    // E3a rule 3: auto-fixes first, so a fixed problem never costs a regeneration.
    const { decision: polished, autoFixes } = polishDecision(decided.json, { ownerName: ctx.lead.ownerName, companyName: ctx.companyName });
    let rules = validateDecision(polished, ctx.rules, ctx.settings, deps.now);
    // E2b rule 1 + E2c (both modes): deterministic writing checks, before grounding; recorded as rule violations.
    const messageViolations = rules.outcome === "blocked" ? [] : checkMessage(rules.finalDecision, ctx.settings, messageFactsOf(ctx));
    if (messageViolations.length) rules = { ...rules, allowed: false, executable: false, violations: [...rules.violations, ...messageViolations] };
    let grounding: GroundingResult | null = null;
    if (rules.allowed && isSend(rules.finalDecision)) {
      const checked = await deps.model.checkGrounding({
        model: deps.groundingModel,
        messages: buildGroundingMessages(rules.finalDecision, ctx)!,
        jsonSchema: { name: "grounding_check", schema: GROUNDING_JSON_SCHEMA as unknown as Record<string, unknown> },
      });
      add(deps.groundingModel, checked, tokens);
      grounding = applyGroundingAllowList(checked.json, ctx);
    }
    const unsupported = grounding && !grounding.supported ? (grounding.unsupportedClaims.length ? grounding.unsupportedClaims : ["(not specified)"]) : [];
    // E2b rule 2: style problems from the same grounding call.
    const style = grounding?.styleViolations ?? [];
    return {
      tokens,
      autoFixes,
      decision: decided.json,
      rules,
      grounding,
      problems: [
        ...rules.violations.map((v) => `${v.rule}: ${v.message}`),
        ...unsupported.map((claim) => `Unsupported claim: ${claim}`),
        ...style.map((v) => `${v.rule}: "${v.quote}"`),
      ],
    };
  };

  const attempts = [await attempt()];
  let last = attempts[0]!;
  // A block (the lead changed since the precheck) can't be fixed by rewriting.
  const finished = (a: DraftAttempt) => !a.problems.length || a.rules.outcome === "blocked";
  while (!finished(last) && attempts.length < (fixableOnly(last) ? 3 : 2)) {
    last = await attempt(last.problems);
    attempts.push(last);
  }
  if (finished(last)) {
    return {
      decision: last.rules.finalDecision,
      rules: last.rules,
      grounding: last.grounding,
      outcome: last.rules.outcome === "blocked" ? "blocked" : "draft",
      regenerated: attempts.length > 1,
      failedAttempt: null,
      attempts,
    };
  }
  return {
    decision: {
      action: "handoff",
      title: handoffTitle(last.problems),
      urgency: "normal",
      reasoning: `${attempts.length === 2 ? "Two" : "Three"} attempts failed the checks: ${last.problems.join("; ")}`.slice(0, 2000),
    },
    rules: last.rules,
    grounding: last.grounding,
    outcome: "draft",
    regenerated: true,
    failedAttempt: last,
    attempts,
  };
}

function handoffTitle(problems: string[]): string {
  const rules = problems.map(ruleOf);
  if (rules.every((r) => r === QUESTION_RULE)) return QUESTION_HANDOFF_TITLE;
  return rules.every((r) => PLAYBOOK_RULES.includes(r)) ? PLAYBOOK_HANDOFF_TITLE : HANDOFF_TITLE;
}

// --- The worker loop -------------------------------------------------------------

interface ClaimedWakeup {
  id: string;
  workspace_id: string;
  lead_id: string;
  attempt_count: number;
  claimed_at: Date;
}

export interface WakeupOutcome {
  wakeupId: string;
  leadId: string;
  result: "draft" | "executed" | "blocked" | "precheck" | "deferred" | "failed" | "skipped" | "lost_claim";
  action?: string;
}

/**
 * One agent tick: cancel pending wakeups of leads the agent no longer manages,
 * claim up to 5 due wakeups in shadow and live workspaces (reclaiming any stuck in
 * `executing` for 15 min), and process them one at a time. A no-op unless
 * `enabled` (AGENT_RUNNER_ENABLED).
 */
export async function runAgentTick(enabled: boolean, deps: AgentRunnerDeps): Promise<WakeupOutcome[]> {
  if (!enabled) return [];
  const claimed = await claimWakeups(deps.workspaceIds ?? null);
  const configNotes = new Set<string>();
  const outcomes: WakeupOutcome[] = [];
  for (const wakeup of claimed) {
    outcomes.push(await processWakeup(wakeup, deps, configNotes));
  }
  for (const note of configNotes) console.warn(`[agent] ${note}`);
  return outcomes;
}

async function claimWakeups(workspaceIds: string[] | null): Promise<ClaimedWakeup[]> {
  return withTransaction(async (client) => {
    await client.query(
      `update public.agent_wakeups w
          set status = 'cancelled', processed_at = now(),
              payload = coalesce(w.payload, '{}'::jsonb) || jsonb_build_object('cancel_reason', 'lead_not_active')
         from public.leads l
        where l.id = w.lead_id and w.status = 'pending' and l.agent_status <> 'active'
          and ($1::uuid[] is null or w.workspace_id = any($1::uuid[]))`,
      [workspaceIds],
    );
    const result = await client.query<ClaimedWakeup>(
      `update public.agent_wakeups w
          -- Millisecond precision so the claimed_at we hold (a JS Date) matches exactly.
          set status = 'executing', claimed_at = date_trunc('milliseconds', now()), attempt_count = w.attempt_count + 1
        where w.id in (
          select x.id from public.agent_wakeups x
            join public.agent_settings s on s.workspace_id = x.workspace_id and s.mode in ('shadow', 'live')
           where ((x.status = 'pending' and x.due_at <= now())
               or (x.status = 'executing' and x.claimed_at < now() - interval '15 minutes'))
             and ($1::uuid[] is null or x.workspace_id = any($1::uuid[]))
             -- At most one per lead: only the earliest claimable one, and none while another
             -- wakeup for the lead is being processed (a fresh executing row).
             and not exists (
               select 1 from public.agent_wakeups y
                where y.lead_id = x.lead_id and y.id <> x.id
                  and (((y.status = 'pending' and y.due_at <= now())
                        or (y.status = 'executing' and y.claimed_at < now() - interval '15 minutes'))
                       and (y.due_at, y.id) < (x.due_at, x.id)
                    or (y.status = 'executing' and y.claimed_at >= now() - interval '15 minutes')))
           order by x.due_at
           limit $2
           for update of x skip locked)
        returning w.id, w.workspace_id, w.lead_id, w.attempt_count, w.claimed_at`,
      [workspaceIds, BATCH_SIZE],
    );
    return result.rows;
  });
}

/** Ends our claim on the wakeup: only while it is still ours (executing, same claimed_at). */
async function markDone(wakeup: ClaimedWakeup): Promise<void> {
  await pool.query(
    `update public.agent_wakeups set status = 'done', processed_at = now()
      where id = $1 and status = 'executing' and claimed_at = $2`,
    [wakeup.id, wakeup.claimed_at],
  );
}

/**
 * Puts the wakeup back to pending at `retryAt` (restoring the attempt for a
 * deferral). If an event wakeup for the lead arrived meanwhile (only one may be
 * pending), that one carries on, no earlier than `retryAt`, and ours is cancelled.
 */
async function retryLater(wakeup: ClaimedWakeup, retryAt: Date, restoreAttempt: boolean): Promise<void> {
  await withTransaction(async (client) => {
    const other = await client.query(
      `update public.agent_wakeups set due_at = greatest(due_at, $3)
        where lead_id = $2 and status = 'pending' and id <> $1 returning id`,
      [wakeup.id, wakeup.lead_id, retryAt],
    );
    await client.query(
      `update public.agent_wakeups
          set status = $4, due_at = $3, claimed_at = null,
              attempt_count = attempt_count - $5,
              processed_at = case when $4 = 'cancelled' then now() end
        where id = $1 and status = 'executing' and claimed_at = $2`,
      [wakeup.id, wakeup.claimed_at, retryAt, other.rowCount ? "cancelled" : "pending", restoreAttempt ? 1 : 0],
    );
  });
}

async function processWakeup(wakeup: ClaimedWakeup, deps: AgentRunnerDeps, configNotes: Set<string>): Promise<WakeupOutcome> {
  const base = { wakeupId: wakeup.id, leadId: wakeup.lead_id };
  const now = new Date();
  const defer = async (ms: number, restore = true): Promise<WakeupOutcome> => {
    await retryLater(wakeup, new Date(Date.now() + ms), restore);
    return { ...base, result: "deferred" };
  };

  // 1. Pre-checks, before any model call.
  const state = (
    await pool.query<AgentSettingsRow & { lifecycle_state: AgentContext["lead"]["lifecycleState"]; agent_status: AgentContext["rules"]["lead"]["agentStatus"] }>(
      `select s.*, l.lifecycle_state, l.agent_status
         from public.agent_settings s join public.leads l on l.workspace_id = s.workspace_id
        where l.id = $1 and s.workspace_id = $2`,
      [wakeup.lead_id, wakeup.workspace_id],
    )
  ).rows[0];
  const blocked = state ? precheck({ mode: state.mode, lead: { lifecycleState: state.lifecycle_state, agentStatus: state.agent_status } }, state) : { rule: "lead", message: "Lead not found." };
  if (!state || blocked) {
    await markDone(wakeup);
    console.log(`[agent] wakeup ${wakeup.id} lead ${wakeup.lead_id}: skipped (${blocked?.rule}).`);
    return { ...base, result: "precheck" };
  }

  // 2. Configuration: models with prices, and a playbook. Deferrals don't burn an attempt.
  const prices = deps.prices ?? parsePrices(env.OPENAI_PRICES_JSON);
  let models: { decisionModel: string; groundingModel: string };
  try {
    models = resolveAgentModels(state, deps.defaultModels);
  } catch {
    configNotes.add("No AI model configured; agent wakeups deferred 10 min.");
    return defer(CONFIG_RETRY_MS);
  }
  const unpriced = [models.decisionModel, models.groundingModel].filter((m) => !priceOf(prices, m));
  if (unpriced.length) {
    configNotes.add(`No price in OPENAI_PRICES_JSON for ${[...new Set(unpriced)].join(", ")}; agent wakeups deferred 10 min.`);
    return defer(CONFIG_RETRY_MS);
  }
  if (state.current_playbook_version === null) {
    console.log(`[agent] wakeup ${wakeup.id}: workspace ${wakeup.workspace_id} has no playbook; deferred 1 h.`);
    return defer(PLAYBOOK_RETRY_MS);
  }

  // 3. Budget for the current IST calendar month.
  const spent = Number(
    (
      await pool.query<{ spent: string }>(`select ${MONTH_SPEND_SQL} as spent`, [wakeup.workspace_id])
    ).rows[0]!.spent,
  );
  const budget = Number(state.monthly_budget_usd);
  if (spent >= budget) {
    await alertAdminsOnce(wakeup.workspace_id, "budget_alerted_month", IST_MONTH, "AI agent paused: monthly budget reached",
      `Spent $${spent.toFixed(2)} of $${budget.toFixed(2)} this month. The agent resumes next month or when an admin raises the budget in Settings → AI agent.`);
    console.log(`[agent] wakeup ${wakeup.id}: workspace ${wakeup.workspace_id} reached its monthly budget; deferred 1 h.`);
    return defer(BUDGET_RETRY_MS);
  }

  // 3b. Daily decision cap (IST day); at the cap, wait for the next IST day.
  const today = (
    await pool.query<{ n: number; resume_at: Date }>(
      `select count(*)::int as n, ((${IST_DAY} + interval '1 day 5 minutes') at time zone 'Asia/Kolkata') as resume_at
         from public.agent_decisions
        where workspace_id = $1 and created_at >= (${IST_DAY} at time zone 'Asia/Kolkata')`,
      [wakeup.workspace_id],
    )
  ).rows[0]!;
  if (today.n >= state.max_decisions_per_day) {
    await alertAdminsOnce(wakeup.workspace_id, "daily_cap_alerted_on", IST_DAY, "AI agent paused for today: daily decision limit reached",
      `${today.n} AI decisions today (limit ${state.max_decisions_per_day}). The agent resumes after midnight IST or when an admin raises "Max AI decisions per day" in Settings → AI agent.`);
    console.log(`[agent] wakeup ${wakeup.id}: workspace ${wakeup.workspace_id} reached its daily decision cap; deferred to the next IST day.`);
    await retryLater(wakeup, today.resume_at, true);
    return { ...base, result: "deferred" };
  }

  // 4-7. Context and the model calls (no client held).
  const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
  let ctx: AgentContext | null = null;
  try {
    ctx = await buildAgentContext(pool, wakeup.workspace_id, wakeup.lead_id, now, { embedder: deps.embedder });
    const draft = await draftDecision(ctx, { model: deps.model, ...models, prices, now }, usage);
    return await recordDraft(wakeup, ctx, draft, models, usage);
  } catch (error) {
    if (error instanceof ProviderDeferredError) {
      console.warn(`[agent] wakeup ${wakeup.id}: deferred (${error.message}).`);
      return defer(error.retryAfterMs || CONFIG_RETRY_MS);
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (error instanceof PermanentProviderError || wakeup.attempt_count >= MAX_ATTEMPTS) {
      await recordFailure(wakeup, ctx, models, usage, message);
      console.error(`[agent] wakeup ${wakeup.id} lead ${wakeup.lead_id}: failed after attempt ${wakeup.attempt_count} (${error instanceof Error ? error.name : "error"}).`);
      return { ...base, result: "failed" };
    }
    console.warn(`[agent] wakeup ${wakeup.id}: attempt ${wakeup.attempt_count} failed (${error instanceof Error ? error.name : "error"}); retrying in 5 min.`);
    return defer(FAILURE_RETRY_MS, false);
  }
}

function decisionColumns(decision: AgentDecision) {
  return {
    action: decision.action,
    reasoning: decision.reasoning,
    message_subject: decision.action === "send_email" ? decision.subject : null,
    message_body: isSend(decision) ? decision.body : null,
    asset_ids: isSend(decision) ? decision.assetIds : null,
    handoff_title: decision.action === "handoff" ? decision.title : null,
    handoff_urgency: decision.action === "handoff" ? decision.urgency : null,
    new_stage: decision.action === "update_stage" ? decision.newStage : null,
    stop_reason: decision.action === "stop" ? decision.reason : null,
  };
}

const INSERT_DECISION = `
  insert into public.agent_decisions
    (workspace_id, lead_id, wakeup_id, action, reasoning, message_subject, message_body, asset_ids,
     send_at, next_wake_at, handoff_title, handoff_urgency, new_stage, stop_reason, rules_result, grounding_result,
     regenerated, chunk_ids, playbook_version, decision_model, grounding_model, input_tokens, output_tokens, cost_usd,
     outcome, error, context_company_id, context_deal_id, context_deal_stage, mode, send_status, send_next_at, quality_checks)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33)
  returning id`;

/** One quality_checks entry; `attachmentsRemoved` only when the rules dropped an attachment (E2g). */
function qualityCheck(a: DraftAttempt, ctx: AgentContext) {
  const removed = a.rules.attachmentsRemoved ?? [];
  // E3a rule 2: the attempt's input tokens and the part OpenAI served from its prompt cache.
  const tokens = { inputTokens: a.tokens.input, cachedInputTokens: a.tokens.cached, ...(a.autoFixes.length ? { autoFixes: a.autoFixes } : {}) };
  if (!removed.length) return { problems: a.problems, ...tokens };
  return {
    problems: a.problems,
    ...tokens,
    attachmentsRemoved: removed.map((r) => ({ ...r, title: ctx.assets.find((asset) => asset.id === r.assetId)?.title ?? null })),
  };
}

/** Which company and open deal (stage at the time) the decision saw, for review (D1). */
const contextColumns = (ctx: AgentContext | null) => [ctx?.company?.id ?? null, ctx?.internal.deal.open?.id ?? null, ctx?.internal.deal.open?.stage ?? null];

async function recordDraft(
  wakeup: ClaimedWakeup,
  ctx: AgentContext,
  draft: DraftResult,
  models: { decisionModel: string; groundingModel: string },
  usage: Usage,
): Promise<WakeupOutcome> {
  const base = { wakeupId: wakeup.id, leadId: wakeup.lead_id };
  return withTransaction(async (client) => {
    const ours = await client.query(`select 1 from public.agent_wakeups where id = $1 and status = 'executing' and claimed_at = $2 for update`, [wakeup.id, wakeup.claimed_at]);
    if (!ours.rowCount) {
      console.warn(`[agent] wakeup ${wakeup.id}: claim lost while deciding; result discarded.`);
      return { ...base, result: "lost_claim" as const };
    }
    const lead = (await client.query<{ agent_status: string }>(`select agent_status from public.leads where id = $1 for update`, [wakeup.lead_id])).rows[0];
    const stillActive = lead?.agent_status === "active";

    const columns = decisionColumns(draft.decision);
    // A handoff fallback keeps the failed attempt's message for review.
    const failed = draft.failedAttempt ? decisionColumns(draft.failedAttempt.rules.finalDecision) : null;
    // E2: a live contact's decision is acted on (executed), a shadow contact's stays a draft.
    const live = ctx.rules.mode === "live";
    const outcome = !stillActive ? "skipped" : live && draft.outcome === "draft" ? "executed" : draft.outcome;
    const queuedSend = outcome === "executed" && isSend(draft.decision);
    const recorded = draft.decision.action === "handoff" && failed ? { ...columns, message_subject: failed.message_subject, message_body: failed.message_body } : columns;
    const sendAt = draft.failedAttempt ? null : draft.rules.sendAt;
    const nextWakeAt = draft.failedAttempt ? null : draft.rules.nextWakeAt;
    const inserted = await client.query<{ id: string }>(INSERT_DECISION, [
      wakeup.workspace_id,
      wakeup.lead_id,
      wakeup.id,
      recorded.action,
      recorded.reasoning,
      recorded.message_subject,
      recorded.message_body,
      recorded.asset_ids,
      sendAt,
      nextWakeAt,
      recorded.handoff_title,
      recorded.handoff_urgency,
      recorded.new_stage,
      recorded.stop_reason,
      JSON.stringify(draft.rules),
      draft.grounding ? JSON.stringify(draft.grounding) : null,
      draft.regenerated,
      ctx.knowledge.chunks.map((c) => c.id),
      ctx.playbook?.version ?? null,
      models.decisionModel,
      models.groundingModel,
      usage.inputTokens,
      usage.outputTokens,
      usage.costUsd,
      outcome,
      stillActive ? null : "The lead is no longer managed by the agent.",
      ...contextColumns(ctx),
      live ? "live" : "shadow",
      queuedSend ? "queued" : null,
      queuedSend ? sendAt : null,
      // E2b rule 3: what each attempt failed (empty = passed), for AI Activity; E2g: attachments it dropped.
      JSON.stringify(draft.attempts.map((a) => qualityCheck(a, ctx))),
    ]);
    const decisionId = inserted.rows[0]!.id;

    if (outcome === "draft" || outcome === "executed") {
      const d = draft.decision;
      if ((isSend(d) || d.action === "wait") && nextWakeAt) {
        await enqueueWakeup(client, { workspaceId: wakeup.workspace_id, leadId: wakeup.lead_id, reason: "timer", dueAt: nextWakeAt, payload: { decisionId } });
      }
      if (outcome === "draft") {
        const title = timelineTitle(d);
        if (title) {
          await addTimelineEvent(client, { leadId: wakeup.lead_id, kind: "automation", title, detail: SHADOW_NOTE, ...AGENT_ACTOR, metadata: { decisionId } });
        }
      } else {
        await executeLive(client, wakeup, ctx, d, decisionId, sendAt);
      }
    }
    await client.query(`update public.agent_wakeups set status = 'done', processed_at = now() where id = $1`, [wakeup.id]);
    console.log(
      `[agent] wakeup ${wakeup.id} lead ${wakeup.lead_id}: decision ${decisionId} ${draft.decision.action} ${outcome}${draft.regenerated ? " (regenerated)" : ""}, tokens ${usage.inputTokens}/${usage.outputTokens}, cost $${usage.costUsd.toFixed(6)}.`,
    );
    return { ...base, result: outcome === "draft" || outcome === "executed" ? outcome : outcome === "blocked" ? "blocked" : "skipped", action: draft.decision.action };
  });
}

const DAY_MS = 24 * 3_600_000;

/**
 * E2 rule 8, in the decision's transaction: an email is queued in email_outbound_messages
 * (source 'agent', one per decision; WhatsApp sends are claimed from the decision row);
 * handoff, stop and update_stage are executed. Each send/action writes its own timeline row.
 */
async function executeLive(client: Queryable, wakeup: ClaimedWakeup, ctx: AgentContext, d: AgentDecision, decisionId: string, sendAt: Date | null) {
  const { workspace_id: workspaceId, lead_id: leadId } = wakeup;
  switch (d.action) {
    case "send_email": {
      const composed = composeOutgoing(d, { ownerName: ctx.lead.ownerName ?? "The team", companyName: ctx.companyName, settings: ctx.settings, isFirstWhatsApp: false });
      if (composed.channel !== "email") return;
      await enqueueEmail(client, {
        workspaceId,
        source: "agent",
        sourceId: decisionId,
        leadId,
        to: ctx.rules.lead.email!,
        subject: composed.subject,
        html: composed.html,
        attachments: await assetAttachments(client, workspaceId, d.assetIds),
        notBefore: sendAt,
      });
      return;
    }
    case "handoff":
      return executeHandoff(client, workspaceId, leadId, decisionId, d.title);
    case "stop":
      return executeStop(client, leadId, decisionId, d.reason);
    case "update_stage":
      await executeStageChange(client, workspaceId, leadId, decisionId, d.newStage);
      // The contact stays with the AI; look again after the shortest wake gap.
      await enqueueWakeup(client, { workspaceId, leadId, reason: "timer", dueAt: new Date(Date.now() + ctx.settings.wake_min_days * DAY_MS), payload: { decisionId } });
      return;
    default:
      return;
  }
}

/** E2g rule 6: the decision's (rules-checked) assets as email attachments: Storage refs, file name = title + extension. */
async function assetAttachments(client: Queryable, workspaceId: string, assetIds: string[]): Promise<AttachmentRef[]> {
  if (!assetIds.length) return [];
  const rows = (
    await client.query<{ id: string; title: string; storage_path: string; file_name: string | null; mime_type: string | null; size_bytes: string | null }>(
      `select id, title, storage_path, file_name, mime_type, size_bytes from public.agent_assets where id = any($1::uuid[]) and workspace_id = $2 and is_active`,
      [assetIds, workspaceId],
    )
  ).rows;
  return assetIds
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is (typeof rows)[number] => Boolean(r))
    .map((r) => ({
      bucket: AGENT_ASSETS_BUCKET,
      path: r.storage_path,
      fileName: attachmentFileName(r.title, r.file_name),
      mimeType: r.mime_type || "application/octet-stream",
      size: r.size_bytes === null ? null : Number(r.size_bytes),
      assetId: r.id,
      title: r.title,
    }));
}

function timelineTitle(decision: AgentDecision): string | null {
  const words = (value: string) => value.replace(/_/g, " ");
  switch (decision.action) {
    case "send_email":
      return `AI drafted email: ${decision.subject}`.slice(0, 300);
    case "send_whatsapp":
      return "AI drafted WhatsApp message";
    case "handoff":
      return `AI suggested handoff: ${decision.title}`.slice(0, 300);
    case "update_stage":
      return `AI suggested stage: ${words(decision.newStage)}`;
    case "stop":
      return `AI suggested stopping: ${words(decision.reason)}`;
    case "wait":
      return null;
  }
}

/** A `failed` decision row (no AI text) and the wakeup done. */
async function recordFailure(
  wakeup: ClaimedWakeup,
  ctx: AgentContext | null,
  models: { decisionModel: string; groundingModel: string },
  usage: Usage,
  error: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const ours = await client.query(`select 1 from public.agent_wakeups where id = $1 and status = 'executing' and claimed_at = $2 for update`, [wakeup.id, wakeup.claimed_at]);
    if (!ours.rowCount) return;
    await client.query(
      `insert into public.agent_decisions
         (workspace_id, lead_id, wakeup_id, mode, action, playbook_version, decision_model, grounding_model, input_tokens, output_tokens, cost_usd, outcome, error,
          context_company_id, context_deal_id, context_deal_stage)
       values ($1, $2, $3, 'shadow', 'wait', $4, $5, $6, $7, $8, $9, 'failed', $10, $11, $12, $13)`,
      [wakeup.workspace_id, wakeup.lead_id, wakeup.id, ctx?.playbook?.version ?? null, models.decisionModel, models.groundingModel, usage.inputTokens, usage.outputTokens, usage.costUsd, error.slice(0, 1000), ...contextColumns(ctx)],
    );
    await client.query(`update public.agent_wakeups set status = 'done', processed_at = now() where id = $1`, [wakeup.id]);
  });
}

/**
 * Notifies every active admin once per IST period (`period` = IST_MONTH or IST_DAY); `column`
 * holds the period's date and is claimed atomically, so concurrent wakeups alert once.
 */
async function alertAdminsOnce(
  workspaceId: string,
  column: "budget_alerted_month" | "daily_cap_alerted_on",
  period: string,
  title: string,
  detail: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const claimed = await client.query(
      `update public.agent_settings set ${column} = (${period})::date
        where workspace_id = $1 and ${column} is distinct from (${period})::date
        returning workspace_id`,
      [workspaceId],
    );
    if (!claimed.rowCount) return;
    await client.query(
      `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, href)
       select $1, p.id, $2, $3, 'warning', '/settings'
         from public.profiles p where p.role = 'admin' and p.is_active`,
      [workspaceId, title, detail],
    );
  });
}
