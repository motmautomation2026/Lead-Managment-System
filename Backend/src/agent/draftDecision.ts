import type { AgentContext } from "../services/agentContext.service.js";
import { DECISION_JSON_SCHEMA, type AgentDecision } from "./decisionSchema.js";
import { costUsd, type ModelPrices } from "./pricing.js";
import { applyGroundingAllowList, buildDecisionMessages, buildGroundingMessages, GROUNDING_JSON_SCHEMA, STYLE_RULES, type GroundingResult } from "./prompt.js";
import { checkMessage, firstClosingOf, messageFactsOf } from "./messageChecks.js";
import { polishDecision, type AutoFix } from "./polish.js";
import { suggestedDays, type Channel } from "./stagePlan.js";
import { threadSubject } from "../domain/emailSafety.js";
import { validateDecision, type RulesResult } from "./rules.js";
import type { DecisionModel, ModelCallResult } from "../providers/openai.provider.js";

/**
 * The decision pipeline (no DB; DEMO-1: moved here from services/agentRunner.service.ts, which
 * re-exports it): decide → validate → ground → regenerate → handoff fallback. Shared by the worker,
 * scripts/agent-preview.ts, agent:model-test and the offline agent:demo-journey.
 */

const HANDOFF_TITLE = "AI couldn't write a safe message";
const QUESTION_HANDOFF_TITLE = "AI couldn't write a one-question message";
const PLAYBOOK_HANDOFF_TITLE = "AI couldn't write a message that meets the playbook";
const QUESTION_RULE = "one_question";
// Problems that are about the playbook's writing rules (E2b), not safety or facts.
// internal_info_leak is a safety problem, not a playbook one ("AI couldn't write a safe message").
const PLAYBOOK_RULES = ["banned_phrase", "length", QUESTION_RULE, "compound_question", "exclamation", "not_thanking_inbound", "attachment_mention", "subject_style", "contact_details", "unsupported_agreement", "call_days", "generic_client_claim", "repeated_client_experience", "stale_call_thanks", ...STYLE_RULES];
const ruleOf = (problem: string) => problem.slice(0, problem.indexOf(":"));
// E2f rule 7: code-checked writing problems a rewrite reliably fixes; only these earn a second regeneration.
const FIXABLE_RULES = ["generic_client_claim", QUESTION_RULE, "compound_question", "banned_phrase", "length", "exclamation", "not_thanking_inbound", "introduction_mid_conversation", "attachment_mention", "subject_style", "contact_details", "content_contacts", "unsupported_agreement", "call_days", "repeated_client_experience", "stale_call_thanks"];
// Grounding only runs when the code checks pass, so a grounded attempt (unsupported claim / style) is never "fixable only".
const fixableOnly = (a: DraftAttempt) => !a.grounding && a.rules.violations.length > 0 && a.rules.violations.every((v) => FIXABLE_RULES.includes(v.rule));


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
    const { decision: polished, autoFixes } = polishDecision(decided.json, {
      ownerName: ctx.lead.ownerName,
      companyName: ctx.companyName,
      suggestedDays: suggestedDays(deps.now),
      firstClosing: firstClosingOf(ctx),
    });
    // E3a rule 7: a follow-up email keeps its thread's subject; the model's is ignored.
    const thread = ctx.emailThread;
    const final = thread && polished.action === "send_email" ? { ...polished, subject: threadSubject(thread.subject) } : polished;
    let rules = validateDecision(final, ctx.rules, ctx.settings, deps.now);
    // E2b rule 1 + E2c (both modes): deterministic writing checks, before grounding; recorded as rule violations.
    const messageViolations = rules.outcome === "blocked" ? [] : checkMessage(rules.finalDecision, ctx.settings, messageFactsOf(ctx, deps.now));
    if (messageViolations.length) rules = { ...rules, allowed: false, executable: false, violations: [...rules.violations, ...messageViolations] };
    let grounding: GroundingResult | null = null;
    if (rules.allowed && isSend(rules.finalDecision)) {
      const checked = await deps.model.checkGrounding({
        model: deps.groundingModel,
        messages: buildGroundingMessages(rules.finalDecision, ctx)!,
        jsonSchema: { name: "grounding_check", schema: GROUNDING_JSON_SCHEMA as unknown as Record<string, unknown> },
      });
      add(deps.groundingModel, checked, tokens);
      grounding = applyGroundingAllowList(checked.json, ctx, deps.now);
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

/** HOTFIX-2: the second message of a "both" first message: `ok` = it passed every check, else its failed send is kept for review. */
export interface CompanionDraft {
  draft: DraftResult;
  ok: boolean;
}

const passedSend = (d: DraftResult) => d.outcome === "draft" && !d.failedAttempt && isSend(d.decision);

/** The context with the stage plan narrowed to one channel (no second channel). */
export function forChannel(ctx: AgentContext, channel: Channel): AgentContext {
  const plan = ctx.stagePlan!;
  const narrowed = {
    ...plan,
    preferredChannel: channel,
    alsoChannel: undefined,
    allowedActions: [`send_${channel}` as const, ...plan.allowedActions.filter((a) => a !== "send_email" && a !== "send_whatsapp")],
  };
  return { ...ctx, stagePlan: narrowed, rules: { ...ctx.rules, stagePlan: narrowed } };
}

/**
 * HOTFIX-2: a "both" first message (stagePlan.alsoChannel): when the first draft is a message (passed or failed
 * its checks), a second one is written for the other channel, each through every check. `main` is a passing
 * message when there is one; `companion` is the other channel's message (passed, or failed for review), else null.
 * One channel never gets two messages. Without alsoChannel this is draftDecision.
 */
export async function draftFirstMessages(
  ctx: AgentContext,
  deps: Parameters<typeof draftDecision>[1],
  usage: Usage,
): Promise<{ main: DraftResult; companion: CompanionDraft | null }> {
  const also = ctx.stagePlan?.alsoChannel;
  const first = await draftDecision(also ? forChannel(ctx, ctx.stagePlan!.preferredChannel!) : ctx, deps, usage);
  const wroteMessage = first.outcome !== "blocked" && first.attempts.some((a) => isSend(a.rules.finalDecision));
  if (!also || !wroteMessage) return { main: first, companion: null };
  const second = await draftDecision(forChannel(ctx, also), deps, usage);
  const failedSend = (d: DraftResult) => Boolean(d.failedAttempt && isSend(d.failedAttempt.rules.finalDecision));
  if (passedSend(first)) return { main: first, companion: passedSend(second) || failedSend(second) ? { draft: second, ok: passedSend(second) } : null };
  if (passedSend(second)) return { main: second, companion: failedSend(first) ? { draft: first, ok: false } : null };
  return { main: first, companion: null };
}

function handoffTitle(problems: string[]): string {
  const rules = problems.map(ruleOf);
  if (rules.every((r) => r === QUESTION_RULE)) return QUESTION_HANDOFF_TITLE;
  return rules.every((r) => PLAYBOOK_RULES.includes(r)) ? PLAYBOOK_HANDOFF_TITLE : HANDOFF_TITLE;
}
