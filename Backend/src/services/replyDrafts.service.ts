/**
 * E3b-2a: suggested replies for reps. When a lead replies (WhatsApp or email) to a contact the AI
 * managed, the worker writes ONE suggested answer for the owner (rules 1–3). The AI never sends it;
 * the owner or an admin sends it (edited or not) through the channel queues and all their safety
 * rules (rule 4), or discards it. The lead's reply text is decrypted only in the draft step, used only
 * inside the prompt's delimited block, and never logged or stored here.
 */
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import type { Actor } from "../authMiddleware.js";
import { env } from "../env.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { composeOutgoing } from "../agent/composeMessage.js";
import { DECISION_JSON_SCHEMA, type AgentDecision, type SendDecision } from "../agent/decisionSchema.js";
import { checkMessage, messageFactsOf } from "../agent/messageChecks.js";
import { polishDecision } from "../agent/polish.js";
import { suggestedDays } from "../agent/stagePlan.js";
import { costUsd, parsePrices, priceOf, type ModelPrices } from "../agent/pricing.js";
import { applyGroundingAllowList, buildReplyDraftGroundingMessages, buildReplyDraftMessages, GROUNDING_JSON_SCHEMA } from "../agent/prompt.js";
import type { ReplyChannel, ReplyLabel } from "../agent/replyClassification.js";
import { REPLY_TASK_TITLES } from "../agent/replyClassification.js";
import type { AgentMode } from "../agent/rules.js";
import { threadSubject } from "../domain/emailSafety.js";
import {
  contactSendProblem,
  DRAFT_DEBOUNCE_MS,
  draftSkipReason,
  MAX_BURST_REPLIES,
  MAX_DRAFTS_PER_CONTACT_PER_DAY,
  replySendAt,
  replySendProblem,
  SEEDED_DRAFT_MODEL,
  SEEDED_DRAFT_SEND_MESSAGE,
  type ContactSendState,
} from "../domain/replyDrafts.js";
import { DEFAULT_SEND_WINDOW, type SendWindow } from "../domain/whatsappSafety.js";
import { resolveAgentModels, type DecisionModel, type Embedder } from "../providers/openai.provider.js";
import { PermanentProviderError, ProviderDeferredError, SendCancelledError } from "../providers/provider-errors.js";
import { sendWhatsApp, wasSentForSource } from "../providers/whatsapp.provider.js";
import type { WhatsAppSendSource } from "../providers/baileys.manager.js";
import { buildAgentContext, type AgentContext } from "./agentContext.service.js";
import { DAY_DECISIONS_SQL, MONTH_SPEND_SQL } from "./agentRunner.service.js";
import { enqueueEmail } from "./emailOutbound.service.js";
import { canReadReplies, decryptInboundBody, emailReplyAad, whatsappReplyAad, type EmailReplyBody, type InboundBody } from "./inboundReplies.service.js";
import { completeTask } from "./tasks.service.js";
import { addTimelineEvent } from "./timeline.service.js";

const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 3;
const MINUTE = 60_000;
const CONFIG_RETRY_MS = 10 * MINUTE;
const SEND_RETRY_MS = 5 * MINUTE;
const MAX_SEND_ATTEMPTS = 3;
// The thread we started, else a neutral subject (never the lead's own subject: that is their text).
const FALLBACK_SUBJECT = "Re: your message";

type EventSql = { table: string; key: string; aad: (id: string) => string; extra: string };
const EVENTS: Record<ReplyChannel, EventSql> = {
  whatsapp: { table: "public.whatsapp_inbound_events", key: "message_id", aad: whatsappReplyAad, extra: "null::text as in_reply_to, null::uuid as outbound_id" },
  email: { table: "public.email_inbound_events", key: "id", aad: emailReplyAad, extra: "e.message_id_header as in_reply_to, e.outbound_id" },
};
const DRAFT_REF: Record<ReplyChannel, string> = { whatsapp: "whatsapp_message_id", email: "email_event_id" };

// --- Ingestion (inside the reply's transaction) --------------------------------------

/**
 * E3b-2a-2 rule 1: a reply on a contact handed off by an earlier reply still gets a label and a draft
 * while that conversation is open: an open reply task, or a suggested reply already written for it.
 */
export async function isReplyFollowUp(db: Queryable, leadId: string, agentStatus: string): Promise<boolean> {
  if (agentStatus !== "handed_off") return false;
  const row = await db.query(
    `select 1 where exists (select 1 from public.tasks where lead_id = $1 and origin = 'agent' and status = 'open' and title = any($2::text[]))
                 or exists (select 1 from public.reply_drafts where lead_id = $1)`,
    [leadId, REPLY_TASK_TITLES],
  );
  return Boolean(row.rowCount);
}

/**
 * Called for every matched reply. Any earlier open draft or pending draft step of the contact is
 * superseded (rule 3: the newest reply wins), except after the contact's daily draft limit (E3b-2b
 * rule 2): then the open draft stays, marked `newer_reply_at`, since no newer draft can replace it; `eligible` (AI-managed before the reply or a follow-up,
 * mode not off, text stored) queues this reply for the draft step, which waits for its label and
 * (E3b-2a-2) for 3 quiet minutes, then answers every reply since our last message at once.
 */
export async function markReplyForDraft(db: Queryable, input: { channel: ReplyChannel; eventId: string; leadId: string; eligible: boolean }): Promise<void> {
  const limited = await db.query(
    `select 1 from public.reply_drafts
      where lead_id = $1 and created_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')
     having count(*) >= $2`,
    [input.leadId, MAX_DRAFTS_PER_CONTACT_PER_DAY],
  );
  await db.query(
    limited.rowCount
      ? `update public.reply_drafts set newer_reply_at = now() where lead_id = $1 and status = 'open'`
      : `update public.reply_drafts set status = 'superseded' where lead_id = $1 and status = 'open'`,
    [input.leadId],
  );
  for (const e of Object.values(EVENTS)) {
    await db.query(`update ${e.table} set draft_status = 'skipped', draft_next_at = null where lead_id = $1 and draft_status = 'pending'`, [input.leadId]);
  }
  if (!input.eligible) return;
  const e = EVENTS[input.channel];
  await db.query(`update ${e.table} set draft_status = 'pending', draft_next_at = now() + $2 * interval '1 millisecond' where ${e.key} = $1`, [input.eventId, DRAFT_DEBOUNCE_MS]);
}

// --- The draft step (worker, behind AGENT_RUNNER_ENABLED) ---------------------------

export interface ReplyDraftDeps {
  model: DecisionModel;
  embedder: Embedder;
  prices?: ModelPrices;
  defaultModels?: { decision?: string | undefined; grounding?: string | undefined };
  /** Tests: only these workspaces. */
  workspaceIds?: string[];
  now?: () => Date;
}

interface ClaimedReply extends InboundBody {
  channel: ReplyChannel;
  reply_id: string;
  workspace_id: string;
  lead_id: string | null;
  reply_label: ReplyLabel | null;
  draft_attempts: number;
  in_reply_to: string | null;
  outbound_id: string | null;
}

export interface DraftOutcome {
  replyId: string;
  result: "drafted" | "failed" | "skipped" | "deferred" | "retry" | "superseded";
  reason?: string;
}

/** Claims up to 5 pending replies per channel whose label is known (a claim holds the row for 15 min) and drafts one at a time. */
export async function runReplyDrafts(enabled: boolean, deps: ReplyDraftDeps): Promise<DraftOutcome[]> {
  if (!enabled) return [];
  const claimed: ClaimedReply[] = [];
  for (const [channel, e] of Object.entries(EVENTS) as [ReplyChannel, EventSql][]) {
    const rows = await pool.query<ClaimedReply>(
      `update ${e.table} e
          set draft_attempts = e.draft_attempts + 1, draft_next_at = now() + interval '15 minutes'
        where e.${e.key} in (
          select x.${e.key} from ${e.table} x
           where x.draft_status = 'pending' and x.draft_next_at <= now()
             and x.classification_status is distinct from 'pending'
             and ($1::uuid[] is null or x.workspace_id = any($1::uuid[]))
           order by x.draft_next_at
           limit $2
           for update skip locked)
        returning $3::text as channel, e.${e.key}::text as reply_id, e.workspace_id, e.lead_id, e.reply_label, e.draft_attempts,
                  e.body_ciphertext, e.body_iv, e.body_tag, e.body_key_version, ${e.extra}`,
      [deps.workspaceIds ?? null, BATCH_SIZE, channel],
    );
    claimed.push(...rows.rows);
  }
  const outcomes: DraftOutcome[] = [];
  for (const reply of claimed) {
    outcomes.push(
      await draftOne(reply, deps).catch((error: { name?: string }) => {
        // Class names only: an error can quote the reply. The claim expires after 15 min.
        console.error(`[reply-drafts] reply ${reply.reply_id} failed unexpectedly: ${error?.name ?? "error"}`);
        return { replyId: reply.reply_id, result: "retry" as const };
      }),
    );
  }
  return outcomes;
}

/** Ends the draft step for the reply, only while the claim is ours; a lost claim records the cost as superseded. */
async function finish(
  reply: ClaimedReply,
  status: "done" | "skipped" | "failed",
  draft?: { body: string | null; subject: string | null; status: "open" | "failed"; problems?: string[]; model: string; usage: Usage },
): Promise<boolean> {
  return withTransaction(async (db) => {
    const e = EVENTS[reply.channel];
    const ours = (
      await db.query(`select 1 from ${e.table} where ${e.key} = $1 and draft_status = 'pending' and draft_attempts = $2 for update`, [reply.reply_id, reply.draft_attempts])
    ).rowCount;
    if (ours) await db.query(`update ${e.table} set draft_status = $2, draft_next_at = null where ${e.key} = $1`, [reply.reply_id, status]);
    if (draft && reply.lead_id) {
      const rowStatus = ours ? draft.status : "superseded";
      if (rowStatus === "open") await db.query(`update public.reply_drafts set status = 'superseded' where lead_id = $1 and status = 'open'`, [reply.lead_id]);
      await db.query(
        `insert into public.reply_drafts
           (workspace_id, lead_id, channel, ${DRAFT_REF[reply.channel]}, subject, body, in_reply_to, status, problems, model, input_tokens, output_tokens, cost_usd)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         on conflict do nothing`,
        [
          reply.workspace_id,
          reply.lead_id,
          reply.channel,
          reply.reply_id,
          draft.subject,
          draft.body,
          reply.in_reply_to,
          rowStatus,
          draft.problems ?? null,
          draft.model,
          draft.usage.inputTokens,
          draft.usage.outputTokens,
          draft.usage.costUsd,
        ],
      );
    }
    return Boolean(ours);
  });
}

async function retryAt(reply: ClaimedReply, ms: number, restoreAttempt: boolean) {
  const e = EVENTS[reply.channel];
  await pool.query(
    `update ${e.table} set draft_next_at = now() + $3 * interval '1 millisecond', draft_attempts = draft_attempts - $4
      where ${e.key} = $1 and draft_status = 'pending' and draft_attempts = $2`,
    [reply.reply_id, reply.draft_attempts, ms, restoreAttempt ? 1 : 0],
  );
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface DraftState {
  mode: AgentMode;
  decision_model: string | null;
  grounding_model: string | null;
  budget: string;
  spent: string;
  today: number;
  max_decisions_per_day: number;
  owner_id: string | null;
  lifecycle_state: string;
  phone_e164: string | null;
  email: string | null;
  whatsapp_status: string | null;
  email_status: string | null;
  phone_status: string | null;
  contact_drafts_today: number;
}

const contactState = (channel: ReplyChannel, s: Pick<DraftState, "lifecycle_state" | "phone_e164" | "email" | "whatsapp_status" | "email_status" | "phone_status">): ContactSendState => ({
  channel,
  lifecycleState: s.lifecycle_state,
  channelStatus: channel === "email" ? s.email_status : s.whatsapp_status,
  phoneStatus: s.phone_status,
  address: channel === "email" ? s.email : s.phone_e164,
});

const CONTACT_SQL = `l.owner_id, l.lifecycle_state::text as lifecycle_state, l.phone_e164, l.email,
       cw.status as whatsapp_status, ce.status as email_status, cp.status as phone_status`;
const CONTACT_JOINS = `left join public.lead_contact_channels cw on cw.lead_id = l.id and cw.channel = 'whatsapp'
       left join public.lead_contact_channels ce on ce.lead_id = l.id and ce.channel = 'email'
       left join public.lead_contact_channels cp on cp.lead_id = l.id and cp.channel = 'phone'`;

async function draftOne(reply: ClaimedReply, deps: ReplyDraftDeps): Promise<DraftOutcome> {
  const base = { replyId: reply.reply_id };
  const now = deps.now?.() ?? new Date();
  const skip = async (reason: string): Promise<DraftOutcome> => {
    await finish(reply, "skipped");
    console.log(`[reply-drafts] reply ${reply.reply_id}: no draft (${reason}).`);
    return { ...base, result: "skipped", reason };
  };
  if (!reply.lead_id) return skip("contact gone");

  const state = (
    await pool.query<DraftState>(
      `select s.mode, s.decision_model, s.grounding_model, s.monthly_budget_usd as budget, s.max_decisions_per_day,
              ${MONTH_SPEND_SQL} as spent, ${DAY_DECISIONS_SQL} as today, ${CONTACT_SQL},
              (select count(*)::int from public.reply_drafts
                where lead_id = l.id and created_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')) as contact_drafts_today
         from public.agent_settings s
         join public.leads l on l.workspace_id = s.workspace_id and l.id = $2 and l.merged_into_lead_id is null
         ${CONTACT_JOINS}
        where s.workspace_id = $1`,
      [reply.workspace_id, reply.lead_id],
    )
  ).rows[0];
  if (!state) return skip("contact gone");
  const burst = await loadBurst(reply);
  // A reply in the burst still waiting for its label: try again shortly.
  if (burst.some((r) => r.classification_status === "pending")) {
    await retryAt(reply, MINUTE, true);
    return { ...base, result: "deferred", reason: "label pending" };
  }
  const reason = draftSkipReason({
    ...contactState(reply.channel, state),
    labels: burst.map((r) => r.reply_label),
    contactDraftsToday: state.contact_drafts_today,
    mode: state.mode,
    spentUsd: Number(state.spent),
    budgetUsd: Number(state.budget),
    decisionsToday: state.today,
    maxDecisionsPerDay: state.max_decisions_per_day,
    hasOwner: Boolean(state.owner_id),
  });
  if (reason) return skip(reason);

  const prices = deps.prices ?? parsePrices(env.OPENAI_PRICES_JSON);
  let models: { decisionModel: string; groundingModel: string };
  try {
    models = resolveAgentModels(state, deps.defaultModels);
  } catch {
    await retryAt(reply, CONFIG_RETRY_MS, true);
    return { ...base, result: "deferred", reason: "no model" };
  }
  if (!priceOf(prices, models.decisionModel) || !priceOf(prices, models.groundingModel)) {
    console.warn(`[reply-drafts] No price in OPENAI_PRICES_JSON for the writer/checker; reply drafts deferred 10 min.`);
    await retryAt(reply, CONFIG_RETRY_MS, true);
    return { ...base, result: "deferred", reason: "no price" };
  }

  let text: string | null;
  try {
    // Every reply since our last message, oldest first, in the one delimited block.
    const texts = burst.map((r) => {
      const plain = decryptInboundBody(r, EVENTS[r.channel].aad(r.reply_id));
      return plain === null ? "" : r.channel === "email" ? ((b: EmailReplyBody) => (b.text.trim() ? b.text : b.subject))(JSON.parse(plain) as EmailReplyBody) : plain;
    });
    text = texts.filter((t) => t.trim()).join("\n\n---\n\n") || null;
  } catch {
    console.warn(`[reply-drafts] could not decrypt reply ${reply.reply_id}; no draft.`);
    await finish(reply, "failed");
    return { ...base, result: "failed", reason: "decrypt" };
  }
  if (!text?.trim()) return skip("no text");

  const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  try {
    const ctx = await buildAgentContext(pool, reply.workspace_id, reply.lead_id, now, { embedder: deps.embedder });
    const written = await writeReplyDraft(ctx, text, reply.channel, { model: deps.model, ...models, prices, now }, usage);
    text = null;
    const subject = reply.channel === "email" ? await draftSubject(reply.outbound_id) : null;
    const draft = written.decision
      ? { body: written.decision.body, subject, status: "open" as const, model: models.decisionModel, usage }
      : { body: null, subject, status: "failed" as const, problems: written.problems, model: models.decisionModel, usage };
    const ours = await finish(reply, written.decision ? "done" : "failed", draft);
    console.log(`[reply-drafts] reply ${reply.reply_id}: ${!ours ? "superseded" : written.decision ? "drafted" : "failed checks"}, tokens ${usage.inputTokens}/${usage.outputTokens}, cost $${usage.costUsd.toFixed(6)}.`);
    return { ...base, result: !ours ? "superseded" : written.decision ? "drafted" : "failed" };
  } catch (error) {
    text = null;
    if (error instanceof ProviderDeferredError) {
      await retryAt(reply, error.retryAfterMs || CONFIG_RETRY_MS, true);
      return { ...base, result: "deferred" };
    }
    const name = error instanceof Error ? error.name : "error";
    if (error instanceof PermanentProviderError || reply.draft_attempts >= MAX_ATTEMPTS) {
      console.warn(`[reply-drafts] reply ${reply.reply_id}: no draft after attempt ${reply.draft_attempts} (${name}).`);
      await finish(reply, "failed");
      return { ...base, result: "failed", reason: name };
    }
    console.warn(`[reply-drafts] reply ${reply.reply_id}: attempt ${reply.draft_attempts} failed (${name}); retrying.`);
    await retryAt(reply, 2 * MINUTE, false);
    return { ...base, result: "retry" };
  }
}

interface BurstReply extends InboundBody {
  channel: ReplyChannel;
  reply_id: string;
  reply_label: ReplyLabel | null;
  classification_status: string | null;
}

/**
 * E3b-2a-2 rule 1: the contact's matched replies (both channels) since our last message — an AI send,
 * any email to them, or the rep's Send / Discard of a suggested reply — oldest first, at most 10.
 * The claimed reply is always part of it.
 */
async function loadBurst(reply: ClaimedReply): Promise<BurstReply[]> {
  const cols = `e.reply_label, e.classification_status, e.body_ciphertext, e.body_iv, e.body_tag, e.body_key_version, e.received_at`;
  const rows = (
    await pool.query<BurstReply>(
      `with since as (
         select coalesce(greatest(
           (select max(sent_at) from public.agent_decisions where lead_id = $1 and outcome = 'sent'),
           (select max(sent_at) from public.email_outbound_messages where lead_id = $1 and status = 'sent'),
           (select max(greatest(queued_at, discarded_at)) from public.reply_drafts where lead_id = $1)), '-infinity'::timestamptz) as at)
       select * from (
         select 'whatsapp' as channel, e.message_id as reply_id, ${cols}
           from public.whatsapp_inbound_events e, since where e.lead_id = $1 and e.disposition = 'matched' and e.received_at > since.at
         union all
         select 'email', e.id::text, ${cols}
           from public.email_inbound_events e, since where e.lead_id = $1 and e.kind = 'reply' and e.match_status = 'matched' and e.received_at > since.at
       ) r
       order by received_at desc
       limit $2`,
      [reply.lead_id, MAX_BURST_REPLIES],
    )
  ).rows.reverse();
  if (!rows.some((r) => r.channel === reply.channel && r.reply_id === reply.reply_id)) {
    rows.push({ ...reply, classification_status: null });
  }
  return rows;
}

async function draftSubject(outboundId: string | null): Promise<string> {
  if (!outboundId) return FALLBACK_SUBJECT;
  const row = (await pool.query<{ subject: string }>(`select subject from public.email_outbound_messages where id = $1`, [outboundId])).rows[0];
  return row ? threadSubject(row.subject) : FALLBACK_SUBJECT;
}

const ruleName = (problem: string) => (problem.startsWith("Unsupported claim") ? "unsupported_claim" : problem.slice(0, Math.max(problem.indexOf(":"), 0)) || "problem");

/**
 * Rule 2: write → code checks (word limit, one question, banned phrases, contact details, "as agreed", …) →
 * the checker (facts + style) → one regeneration on any problem → still failing: no draft. Pure apart
 * from the model calls; no DB client is held. Returns check NAMES only, never quotes.
 */
export async function writeReplyDraft(
  ctx: AgentContext,
  replyText: string,
  channel: ReplyChannel,
  deps: { model: DecisionModel; decisionModel: string; groundingModel: string; prices: ModelPrices; now: Date },
  usage: Usage,
): Promise<{ decision: SendDecision | null; problems: string[] }> {
  const add = (modelName: string, r: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }) => {
    usage.inputTokens += r.inputTokens;
    usage.outputTokens += r.outputTokens;
    usage.costUsd += costUsd(deps.prices, modelName, r.inputTokens, r.outputTokens, r.cachedInputTokens ?? 0) ?? 0;
  };
  const action = channel === "email" ? "send_email" : "send_whatsapp";
  const facts = { ...messageFactsOf(ctx), inboundFirst: false, conversationExists: true, threaded: true };
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const decided = await deps.model.decide({
      model: deps.decisionModel,
      messages: buildReplyDraftMessages(ctx, replyText, channel, deps.now, attempt ? problems : undefined),
      jsonSchema: { name: "agent_decision", schema: DECISION_JSON_SCHEMA as unknown as Record<string, unknown> },
    });
    add(deps.decisionModel, decided);
    if (decided.json.action !== action) {
      problems = [`wrong_action: answer with ${action}`];
      continue;
    }
    const polished = polishDecision(decided.json, { ownerName: ctx.lead.ownerName, companyName: ctx.companyName, suggestedDays: suggestedDays(deps.now) }).decision as SendDecision;
    const draft: SendDecision = { ...polished, assetIds: [] } as SendDecision;
    problems = checkMessage(draft as AgentDecision, ctx.settings, facts).map((v) => `${v.rule}: ${v.message}`);
    if (!problems.length) {
      const checked = await deps.model.checkGrounding({
        model: deps.groundingModel,
        messages: buildReplyDraftGroundingMessages(draft, ctx, replyText)!,
        jsonSchema: { name: "grounding_check", schema: GROUNDING_JSON_SCHEMA as unknown as Record<string, unknown> },
      });
      add(deps.groundingModel, checked);
      const grounding = applyGroundingAllowList(checked.json, { ...ctx, stagePlan: null }, deps.now);
      problems = [
        ...(grounding.supported ? [] : (grounding.unsupportedClaims.length ? grounding.unsupportedClaims : ["(not specified)"]).map((c) => `Unsupported claim: ${c}`)),
        ...(grounding.styleViolations ?? []).map((v) => `${v.rule}: "${v.quote}"`),
      ];
    }
    if (!problems.length) return { decision: draft, problems: [] };
  }
  return { decision: null, problems: [...new Set(problems.map(ruleName))] };
}

// --- API: the draft on a reply, Send and Discard -----------------------------------

interface DraftRow {
  id: string;
  workspace_id: string;
  lead_id: string;
  channel: ReplyChannel;
  whatsapp_message_id: string | null;
  email_event_id: string | null;
  subject: string | null;
  body: string | null;
  status: "open" | "sent" | "discarded" | "superseded" | "failed";
  edited: boolean | null;
  sent_body: string | null;
  sent_by_name: string | null;
  queued_at: Date | null;
  send_status: "queued" | "sending" | "sent" | "failed" | "cancelled" | null;
  send_next_at: Date | null;
  sent_at: Date | null;
  send_error: string | null;
  newer_reply_at: Date | null;
  model: string | null;
  contact_first_name: string | null;
  created_at: Date;
}

export function replyDraftToDto(row: DraftRow, canSend: boolean) {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    subject: row.subject,
    body: row.body,
    edited: row.edited,
    sentBody: row.sent_body,
    sentByName: row.sent_by_name,
    queuedAt: row.queued_at?.toISOString() ?? null,
    sendStatus: row.send_status,
    // "Will send at …" while queued (the window's next opening; the worker may add a few minutes of spacing).
    sendAt: row.send_status === "queued" || row.send_status === "sending" ? (row.send_next_at?.toISOString() ?? null) : null,
    sentAt: row.sent_at?.toISOString() ?? null,
    sendError: row.send_error,
    // E3b-2b rule 2: the contact wrote again after this draft (the daily draft limit kept it open).
    newerReplyAt: row.status === "open" ? (row.newer_reply_at?.toISOString() ?? null) : null,
    contactFirstName: row.contact_first_name,
    createdAt: row.created_at.toISOString(),
    canSend: canSend && row.status === "open",
  };
}
export type ReplyDraftDto = ReturnType<typeof replyDraftToDto>;

const DRAFT_COLUMNS = `d.id, d.workspace_id, d.lead_id, d.channel, d.whatsapp_message_id, d.email_event_id, d.subject, d.body, d.status, d.edited,
       d.sent_body, d.sent_by_name, d.queued_at, d.send_status, d.send_next_at, d.sent_at, d.send_error, d.newer_reply_at, d.model, d.created_at,
       (select first_name from public.leads where id = d.lead_id) as contact_first_name`;

/** The draft of each reply (by WhatsApp message id / email event id) of a contact, for the timeline; owner + admins only. */
export async function draftsForReplies(db: Queryable, actor: Actor, leadId: string, ownerId: string | null, replyIds: string[]): Promise<Map<string, ReplyDraftDto>> {
  const out = new Map<string, ReplyDraftDto>();
  if (!replyIds.length || !canReadReplies(actor, ownerId)) return out;
  const rows = await db.query<DraftRow>(
    `select ${DRAFT_COLUMNS} from public.reply_drafts d
      where d.lead_id = $1 and (d.whatsapp_message_id = any($2::text[]) or d.email_event_id::text = any($2::text[]))
        and d.status in ('open', 'sent')`,
    [leadId, replyIds],
  );
  for (const row of rows.rows) out.set(row.whatsapp_message_id ?? row.email_event_id!, replyDraftToDto(row, true));
  return out;
}

/** The contact's open draft (or the latest sent one), for the reply task's Sheet; null when none or not allowed. */
export async function getLatestReplyDraft(db: Queryable, actor: Actor, workspaceId: string, leadId: string): Promise<ReplyDraftDto | null> {
  const lead = (await db.query<{ owner_id: string | null }>(`select owner_id from public.leads where id = $1 and workspace_id = $2`, [leadId, workspaceId])).rows[0];
  if (!lead) throw new NotFoundError("Contact");
  if (!canReadReplies(actor, lead.owner_id)) throw new ForbiddenError("Only the contact owner and admins can see suggested replies.");
  const row = (
    await db.query<DraftRow>(
      `select ${DRAFT_COLUMNS} from public.reply_drafts d where d.lead_id = $1 and d.status in ('open', 'sent') order by (d.status = 'open') desc, d.created_at desc limit 1`,
      [leadId],
    )
  ).rows[0];
  return row ? replyDraftToDto(row, true) : null;
}

async function lockDraft(db: Queryable, actor: Actor, workspaceId: string, leadId: string, draftId: string) {
  const row = (
    await db.query<DraftRow & DraftState & { owner_name: string | null; booking_url: string | null; company_name: string; email_opt_out_text: string; whatsapp_opt_out_text: string; whatsapp_max_words: number; email_max_words: number }>(
      `select ${DRAFT_COLUMNS}, ${CONTACT_SQL}, o.full_name as owner_name, o.booking_url,
              coalesce(nullif(trim(s.company_display_name), ''), w.name) as company_name,
              s.email_opt_out_text, s.whatsapp_opt_out_text, s.whatsapp_max_words, s.email_max_words
         from public.reply_drafts d
         join public.leads l on l.id = d.lead_id
         join public.workspaces w on w.id = d.workspace_id
         join public.agent_settings s on s.workspace_id = d.workspace_id
         left join public.profiles o on o.id = l.owner_id
         ${CONTACT_JOINS}
        where d.id = $1 and d.lead_id = $2 and d.workspace_id = $3
        for update of d`,
      [draftId, leadId, workspaceId],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("Suggested reply");
  if (!canReadReplies(actor, row.owner_id)) throw new ForbiddenError("Only the contact owner and admins can send or discard a suggested reply.");
  return row;
}

async function channelWindow(db: Queryable, workspaceId: string, channel: ReplyChannel): Promise<SendWindow> {
  const row = (
    await db.query<{ days: number[] | null; start: string | null; end: string | null }>(
      channel === "email"
        ? `select send_window_days as days, send_window_start::text as start, send_window_end::text as "end" from public.integration_connections where workspace_id = $1 and id = 'email'`
        : `select send_window_days as days, send_window_start::text as start, send_window_end::text as "end" from public.whatsapp_connection where workspace_id = $1`,
      [workspaceId],
    )
  ).rows[0];
  return row?.days && row.start && row.end ? { days: row.days, start: row.start.slice(0, 5), end: row.end.slice(0, 5) } : DEFAULT_SEND_WINDOW;
}

/** The message as sent: the rep's body, the booking line when it offers a call (email), the owner's signature. */
function composeReply(row: Awaited<ReturnType<typeof lockDraft>>, body: string) {
  const decision = (
    row.channel === "email"
      ? { action: "send_email", subject: row.subject ?? FALLBACK_SUBJECT, body, assetIds: [], nextWakeInDays: 1, reasoning: "reply draft" }
      : { action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 1, reasoning: "reply draft" }
  ) as SendDecision;
  return composeOutgoing(decision, {
    ownerName: row.owner_name ?? "",
    companyName: row.company_name,
    settings: { email_opt_out_text: row.email_opt_out_text, whatsapp_opt_out_text: row.whatsapp_opt_out_text },
    // The lead wrote to us: never a first WhatsApp (no opt-out line).
    isFirstWhatsApp: false,
    bookingUrl: row.channel === "email" ? row.booking_url : null,
    // "check_in" is a call angle: the booking line goes only with a reply that offers a call.
    angle: /\bcall\b/i.test(body) ? "check_in" : null,
  });
}

/**
 * Rule 4: the owner or an admin sends an open draft (as edited). Queued for the worker (never sent
 * here) through the channel's safety rules; one send per draft (a second Send returns the same state).
 * The AI's touch limits do not apply; the channel word limit does (400), opt-out / DNC / channel status 409.
 */
export async function sendReplyDraft(actor: Actor, workspaceId: string, leadId: string, draftId: string, body: string, now = new Date()): Promise<ReplyDraftDto> {
  return withTransaction(async (db) => {
    const row = await lockDraft(db, actor, workspaceId, leadId, draftId);
    if (row.model === SEEDED_DRAFT_MODEL) throw new ConflictError(SEEDED_DRAFT_SEND_MESSAGE);
    if (row.status === "sent") return replyDraftToDto(row, true);
    if (row.status !== "open") throw new ConflictError(`This suggested reply was ${row.status}.`);
    const state = contactState(row.channel, row);
    const blocked = contactSendProblem(state);
    if (blocked) throw new ConflictError(blocked);
    const problem = replySendProblem(state, body, row);
    if (problem) throw new ValidationError(problem);

    const text = body.trim();
    const sendAt = replySendAt(now, await channelWindow(db, workspaceId, row.channel));
    const edited = text !== (row.body ?? "").trim();
    if (row.channel === "email") {
      const message = composeReply(row, text);
      if (message.channel !== "email") throw new Error("unreachable");
      await enqueueEmail(db, { workspaceId, source: "reply_draft", sourceId: row.id, leadId, to: row.email!, subject: message.subject, html: message.html, notBefore: sendAt, createdBy: actor.id });
    }
    const updated = (
      await db.query<DraftRow>(
        `update public.reply_drafts d
            set status = 'sent', sent_body = $2, edited = $3, sent_by = $4, sent_by_name = $5, queued_at = now(),
                send_status = 'queued', send_next_at = $6
          where d.id = $1
          returning ${DRAFT_COLUMNS}`,
        [row.id, text, edited, actor.id, actor.fullName, sendAt],
      )
    ).rows[0]!;
    // The rep answered: the open reply task is done.
    const tasks = await db.query<{ id: string }>(
      `select id from public.tasks where lead_id = $1 and origin = 'agent' and status = 'open' and title = any($2::text[])`,
      [leadId, REPLY_TASK_TITLES],
    );
    for (const task of tasks.rows) await completeTask(db, actor, workspaceId, task.id);
    return replyDraftToDto(updated, true);
  });
}

export async function discardReplyDraft(actor: Actor, workspaceId: string, leadId: string, draftId: string): Promise<ReplyDraftDto> {
  return withTransaction(async (db) => {
    const row = await lockDraft(db, actor, workspaceId, leadId, draftId);
    if (row.status === "discarded") return replyDraftToDto(row, true);
    if (row.status !== "open") throw new ConflictError(`This suggested reply was ${row.status}.`);
    const updated = (
      await db.query<DraftRow>(
        `update public.reply_drafts d set status = 'discarded', discarded_by = $2, discarded_at = now() where d.id = $1 returning ${DRAFT_COLUMNS}`,
        [row.id, actor.id],
      )
    ).rows[0]!;
    return replyDraftToDto(updated, true);
  });
}

// --- Delivery outcomes (WhatsApp loop below; email from emailOutbound.service) -------

export type ReplySendOutcome =
  | { kind: "sent"; providerMessageId: string | null; dryRun: boolean }
  | { kind: "deferred"; until: Date; reason: string }
  | { kind: "failed"; reason: string };

export async function recordReplyDraftOutcome(db: Queryable, draftId: string, outcome: ReplySendOutcome): Promise<void> {
  if (outcome.kind === "deferred") {
    await db.query(`update public.reply_drafts set send_status = 'queued', send_next_at = $2, send_error = $3, send_claimed_at = null where id = $1`, [draftId, outcome.until, outcome.reason]);
    return;
  }
  const row = (
    await db.query<{ lead_id: string; workspace_id: string; channel: ReplyChannel; sent_by: string | null; sent_by_name: string | null; edited: boolean | null }>(
      outcome.kind === "sent"
        ? `update public.reply_drafts set send_status = 'sent', sent_at = now(), provider_message_id = $2, send_error = null, send_claimed_at = null
            where id = $1 and send_status is distinct from 'sent' returning lead_id, workspace_id, channel, sent_by, sent_by_name, edited`
        : `update public.reply_drafts set send_status = 'failed', send_error = $2, send_claimed_at = null
            where id = $1 and send_status is distinct from 'failed' returning lead_id, workspace_id, channel, sent_by, sent_by_name, edited`,
      [draftId, outcome.kind === "sent" ? outcome.providerMessageId : outcome.reason],
    )
  ).rows[0];
  if (!row) return;
  const channel = row.channel === "email" ? "email" : "WhatsApp";
  if (outcome.kind === "sent") {
    await addTimelineEvent(db, {
      leadId: row.lead_id,
      kind: row.channel,
      title: `Reply sent on ${channel}${outcome.dryRun ? " (dry run)" : ""}`,
      detail: `Suggested reply${row.edited ? ", edited" : ""}, sent by ${row.sent_by_name ?? "a rep"}`,
      actorId: row.sent_by,
      actorName: row.sent_by_name ?? "Rep",
      actorSource: "manual",
      metadata: { replyDraftId: draftId, edited: row.edited, dryRun: outcome.dryRun },
    });
  } else if (row.sent_by) {
    await db.query(
      `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, lead_id, href)
       values ($1, $2, $3, $4, 'warning', $5, $6)`,
      [row.workspace_id, row.sent_by, `Your ${channel} reply couldn't be sent`, outcome.reason.slice(0, 500), row.lead_id, `/contacts/${row.lead_id}`],
    );
  }
}

interface ClaimedSend {
  id: string;
  workspace_id: string;
  lead_id: string;
  send_attempts: number;
  send_claimed_at: Date;
}

export interface ReplySendDeps {
  dryRun?: boolean;
  send?: (workspaceId: string, input: { source: WhatsAppSendSource; to: string; body: string }) => Promise<{ providerMessageId: string }>;
  workspaceIds?: string[];
}

/**
 * Worker tick (every tick, no flag: the rep chose to send): claims up to 5 queued WhatsApp reply
 * sends (SKIP LOCKED, reclaimed after 15 min) and sends each through performSend (source
 * reply_draft: send window, spacing, caps, warm-up, pause, and the opt-out / DNC / channel
 * re-check under row locks). No transaction is held across the send.
 */
export async function runReplyDraftSends(deps: ReplySendDeps = {}): Promise<{ id: string; result: string }[]> {
  const claimed = (
    await pool.query<ClaimedSend>(
      `update public.reply_drafts
          set send_status = 'sending', send_claimed_at = date_trunc('milliseconds', now()), send_next_at = now() + interval '15 minutes'
        where id in (
          select id from public.reply_drafts
           where channel = 'whatsapp' and send_status in ('queued', 'sending') and send_next_at <= now()
             and ($1::uuid[] is null or workspace_id = any($1::uuid[]))
           order by send_next_at
           limit $2
           for update skip locked)
        returning id, workspace_id, lead_id, send_attempts, send_claimed_at`,
      [deps.workspaceIds ?? null, BATCH_SIZE],
    )
  ).rows;
  const results: { id: string; result: string }[] = [];
  for (const row of claimed) {
    const result = await sendOne(row, deps).catch((error: { code?: string; name?: string }) => {
      console.error(`[reply-drafts] WhatsApp send ${row.id} failed unexpectedly: ${error?.code ?? error?.name ?? "unknown error"}`);
      return "error";
    });
    results.push({ id: row.id, result });
  }
  return results;
}

async function settle(row: ClaimedSend, outcome: ReplySendOutcome): Promise<string> {
  await withTransaction(async (db) => {
    const ours = await db.query(`select 1 from public.reply_drafts where id = $1 and send_status = 'sending' and send_claimed_at = $2 for update`, [row.id, row.send_claimed_at]);
    if (ours.rowCount) await recordReplyDraftOutcome(db, row.id, outcome);
  });
  return outcome.kind === "sent" && outcome.dryRun ? "dry_run" : outcome.kind;
}

async function sendOne(row: ClaimedSend, deps: ReplySendDeps): Promise<string> {
  const source: WhatsAppSendSource = { type: "reply_draft", id: row.id };
  const already = await pool.query<{ message_id: string }>(`select message_id from public.whatsapp_outbound_messages where reply_draft_id = $1 and status = 'sent'`, [row.id]);
  if (already.rows[0]) return settle(row, { kind: "sent", providerMessageId: already.rows[0].message_id, dryRun: false });

  const info = (
    await pool.query<Awaited<ReturnType<typeof lockDraft>>>(
      `select ${DRAFT_COLUMNS}, ${CONTACT_SQL}, o.full_name as owner_name, o.booking_url,
              coalesce(nullif(trim(s.company_display_name), ''), w.name) as company_name, s.email_opt_out_text, s.whatsapp_opt_out_text
         from public.reply_drafts d
         join public.leads l on l.id = d.lead_id
         join public.workspaces w on w.id = d.workspace_id
         join public.agent_settings s on s.workspace_id = d.workspace_id
         left join public.profiles o on o.id = l.owner_id
         ${CONTACT_JOINS}
        where d.id = $1`,
      [row.id],
    )
  ).rows[0];
  if (!info) return "gone";
  const problem = contactSendProblem(contactState("whatsapp", info));
  if (problem) return settle(row, { kind: "failed", reason: problem });
  if (deps.dryRun) return settle(row, { kind: "sent", providerMessageId: null, dryRun: true });

  try {
    const sent = await (deps.send ?? sendWhatsApp)(row.workspace_id, { source, to: info.phone_e164!, body: composeReply(info, info.sent_body ?? "").text });
    return settle(row, { kind: "sent", providerMessageId: sent.providerMessageId, dryRun: false });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof ProviderDeferredError) return settle(row, { kind: "deferred", until: new Date(Date.now() + error.retryAfterMs), reason });
    if (error instanceof PermanentProviderError || error instanceof SendCancelledError) return settle(row, { kind: "failed", reason });
    if (await wasSentForSource(pool, source)) return settle(row, { kind: "sent", providerMessageId: null, dryRun: false });
    const attempts = row.send_attempts + 1;
    if (attempts >= MAX_SEND_ATTEMPTS) return settle(row, { kind: "failed", reason: `Gave up after ${attempts} attempts: ${reason}` });
    await pool.query(`update public.reply_drafts set send_attempts = $3 where id = $1 and send_claimed_at = $2`, [row.id, row.send_claimed_at, attempts]);
    return settle(row, { kind: "deferred", until: new Date(Date.now() + SEND_RETRY_MS), reason: `Temporary error, will retry: ${reason}` });
  }
}
