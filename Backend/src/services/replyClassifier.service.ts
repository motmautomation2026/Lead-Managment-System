/**
 * D4a: the worker's AI step for WhatsApp replies that matched no keyword.
 * Decrypts the reply only here (and in inboundReplies.service.ts), holds no DB
 * client during the model call, and never logs, stores or returns the text:
 * only the label, its confidence and the call's cost are saved.
 */
import { pool, withTransaction } from "../db.js";
import { env } from "../env.js";
import { costUsd, parsePrices, type ModelPrices } from "../agent/pricing.js";
import { buildReplyClassificationMessages, finalLabel, REPLY_CLASSIFICATION_JSON_SCHEMA, type ReplyLabel } from "../agent/replyClassification.js";
import type { AgentMode } from "../agent/rules.js";
import { resolveAgentModels, type ReplyClassifierModel } from "../providers/openai.provider.js";
import { PermanentProviderError, ProviderDeferredError } from "../providers/provider-errors.js";
import { decryptInboundBody, type InboundBody } from "./inboundReplies.service.js";
import { MONTH_SPEND_SQL } from "./agentRunner.service.js";
import { applyReplyLabel } from "./replyLabels.service.js";

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 3;
const MINUTE = 60_000;
const CONFIG_RETRY_MS = 10 * MINUTE;

export interface ReplyClassifierDeps {
  model: ReplyClassifierModel;
  /** Default: OPENAI_PRICES_JSON. */
  prices?: ModelPrices;
  /** Default: OPENAI_DECISION_MODEL / OPENAI_GROUNDING_MODEL (the grounding model classifies). */
  defaultModels?: { decision?: string | undefined; grounding?: string | undefined };
  /** Tests: only claim events in these workspaces. */
  workspaceIds?: string[];
  /** Tests: replaces the 1 min / 2 min retry backoff. */
  backoffMs?: (attempt: number) => number;
}

interface ClaimedReply extends InboundBody {
  message_id: string;
  workspace_id: string;
  lead_id: string | null;
  classification_attempts: number;
}

export interface ReplyOutcome {
  messageId: string;
  result: "classified" | "skipped" | "failed" | "deferred" | "retry" | "lost_claim";
  label?: ReplyLabel;
}

/** Claims up to 10 pending replies (a claim holds the row for 15 min) and labels them one at a time. No-op unless `enabled`. */
export async function runReplyClassification(enabled: boolean, deps: ReplyClassifierDeps): Promise<ReplyOutcome[]> {
  if (!enabled) return [];
  const claimed = (
    await pool.query<ClaimedReply>(
      `update public.whatsapp_inbound_events e
          set classification_attempts = e.classification_attempts + 1,
              classification_next_at = now() + interval '15 minutes'
        where e.message_id in (
          select x.message_id from public.whatsapp_inbound_events x
           where x.classification_status = 'pending' and x.classification_next_at <= now()
             and ($1::uuid[] is null or x.workspace_id = any($1::uuid[]))
           order by x.classification_next_at
           limit $2
           for update skip locked)
        returning e.message_id, e.workspace_id, e.lead_id, e.classification_attempts,
                  e.body_ciphertext, e.body_iv, e.body_tag, e.body_key_version`,
      [deps.workspaceIds ?? null, BATCH_SIZE],
    )
  ).rows;
  const outcomes: ReplyOutcome[] = [];
  for (const reply of claimed) outcomes.push(await classifyOne(reply, deps));
  return outcomes;
}

/** Writes the label only while the claim is still ours (pending, same attempt count). */
async function finish(reply: ClaimedReply, label: ReplyLabel, extra: { source: "keyword" | "ai"; status: "done" | "failed" | "skipped"; confidence?: number; cost?: Parameters<typeof applyReplyLabel>[1]["cost"] }) {
  return withTransaction(async (client) => {
    const ours = await client.query(
      `select 1 from public.whatsapp_inbound_events where message_id = $1 and classification_status = 'pending' and classification_attempts = $2 for update`,
      [reply.message_id, reply.classification_attempts],
    );
    if (!ours.rowCount) return false;
    if (reply.lead_id) {
      await applyReplyLabel(client, { workspaceId: reply.workspace_id, leadId: reply.lead_id, messageId: reply.message_id, label, ...extra });
    } else {
      // The contact was deleted meanwhile: record the outcome, no effects.
      await client.query(
        `update public.whatsapp_inbound_events set reply_label = 'unclassified', reply_label_source = $2, classification_status = 'skipped',
                classified_at = coalesce(classified_at, now()), classification_next_at = null where message_id = $1`,
        [reply.message_id, extra.source],
      );
    }
    return true;
  });
}

async function retryAt(reply: ClaimedReply, ms: number, restoreAttempt: boolean) {
  await pool.query(
    `update public.whatsapp_inbound_events
        set classification_next_at = now() + $3 * interval '1 millisecond', classification_attempts = classification_attempts - $4
      where message_id = $1 and classification_status = 'pending' and classification_attempts = $2`,
    [reply.message_id, reply.classification_attempts, ms, restoreAttempt ? 1 : 0],
  );
}

async function classifyOne(reply: ClaimedReply, deps: ReplyClassifierDeps): Promise<ReplyOutcome> {
  const base = { messageId: reply.message_id };
  const done = async (result: ReplyOutcome["result"], label: ReplyLabel, extra: Parameters<typeof finish>[2]): Promise<ReplyOutcome> => {
    const ok = await finish(reply, label, extra);
    if (!ok) console.warn(`[replies] message ${reply.message_id}: claim lost; result discarded.`);
    return ok ? { ...base, result, label } : { ...base, result: "lost_claim" };
  };
  const skip = () => done("skipped", "unclassified", { source: "keyword", status: "skipped" });

  const state = (
    await pool.query<{ mode: AgentMode; decision_model: string | null; grounding_model: string | null; budget: string; spent: string }>(
      `select s.mode, s.decision_model, s.grounding_model, s.monthly_budget_usd as budget, ${MONTH_SPEND_SQL} as spent
         from public.agent_settings s where s.workspace_id = $1`,
      [reply.workspace_id],
    )
  ).rows[0];
  // Rule 3: no AI step when the agent was turned off meanwhile or the month's budget is used up.
  if (!state || state.mode === "off" || Number(state.spent) >= Number(state.budget)) {
    console.log(`[replies] message ${reply.message_id}: not classified (${!state || state.mode === "off" ? "agent off" : "monthly budget reached"}).`);
    return skip();
  }

  const prices = deps.prices ?? parsePrices(env.OPENAI_PRICES_JSON);
  let model: string;
  try {
    model = resolveAgentModels(state, deps.defaultModels).groundingModel;
  } catch {
    await retryAt(reply, CONFIG_RETRY_MS, true);
    return { ...base, result: "deferred" };
  }
  if (!prices[model]) {
    console.warn(`[replies] No price in OPENAI_PRICES_JSON for ${model}; reply classification deferred 10 min.`);
    await retryAt(reply, CONFIG_RETRY_MS, true);
    return { ...base, result: "deferred" };
  }

  let text: string | null;
  try {
    text = decryptInboundBody(reply, reply.message_id);
  } catch {
    console.warn(`[replies] could not decrypt inbound message ${reply.message_id}; not classified.`);
    return done("failed", "unclassified", { source: "ai", status: "failed" });
  }
  if (!text) return skip();

  try {
    const result = await deps.model.classifyReply({
      model,
      messages: buildReplyClassificationMessages(text),
      jsonSchema: { name: "reply_label", schema: REPLY_CLASSIFICATION_JSON_SCHEMA as unknown as Record<string, unknown> },
    });
    text = null;
    const label = finalLabel(result.json);
    const cost = { model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: costUsd(prices, model, result.inputTokens, result.outputTokens) };
    const outcome = await done("classified", label, { source: "ai", status: "done", confidence: result.json.confidence, cost });
    console.log(`[replies] message ${reply.message_id}: ${label} (confidence ${result.json.confidence}), tokens ${cost.inputTokens}/${cost.outputTokens}, cost $${(cost.costUsd ?? 0).toFixed(6)}.`);
    return outcome;
  } catch (error) {
    text = null;
    if (error instanceof ProviderDeferredError) {
      await retryAt(reply, error.retryAfterMs || CONFIG_RETRY_MS, true);
      return { ...base, result: "deferred" };
    }
    // Class names only: a model error can quote the reply.
    const name = error instanceof Error ? error.name : "error";
    if (error instanceof PermanentProviderError || reply.classification_attempts >= MAX_ATTEMPTS) {
      console.warn(`[replies] message ${reply.message_id}: not classified after attempt ${reply.classification_attempts} (${name}).`);
      return done("failed", "unclassified", { source: "ai", status: "failed" });
    }
    const wait = deps.backoffMs?.(reply.classification_attempts) ?? MINUTE * 2 ** (reply.classification_attempts - 1);
    console.warn(`[replies] message ${reply.message_id}: attempt ${reply.classification_attempts} failed (${name}); retrying.`);
    await retryAt(reply, wait, false);
    return { ...base, result: "retry" };
  }
}
