import { composeOutgoing } from "./composeMessage.js";
import { DECISION_JSON_SCHEMA, type AgentDecision, type SendDecision } from "./decisionSchema.js";
import { checkMessage, messageFactsOf } from "./messageChecks.js";
import { polishDecision } from "./polish.js";
import { suggestedDays } from "./stagePlan.js";
import { costUsd, type ModelPrices } from "./pricing.js";
import { applyGroundingAllowList, buildReplyDraftGroundingMessages, buildReplyDraftMessages, GROUNDING_JSON_SCHEMA } from "./prompt.js";
import type { ReplyChannel } from "./replyClassification.js";
import type { Usage } from "./draftDecision.js";
import type { AgentContext } from "../services/agentContext.service.js";
import type { DecisionModel } from "../providers/openai.provider.js";

/**
 * E3b-2a: the suggested reply's writer and its composed text. No DB and no provider imports
 * (DEMO-1: moved here from services/replyDrafts.service.ts, which re-exports writeReplyDraft).
 */

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
  const facts = { ...messageFactsOf(ctx, deps.now), inboundFirst: false, conversationExists: true, threaded: true, finalCheck: false, firstMessage: false };
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
    const body = channel === "whatsapp" ? greetByFirstName(polished.body, ctx.lead.firstName) : polished.body;
    const draft: SendDecision = { ...polished, body, assetIds: [] } as SendDecision;
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

/** AI-FIX-1 rule 4: a WhatsApp reply draft starts with the lead's first name ("Hi Sagar,") when the writer left it out. */
export function greetByFirstName(body: string, firstName: string): string {
  const name = firstName.trim();
  const opening = body.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase();
  return !name || opening.includes(name.toLowerCase()) ? body : `Hi ${name},\n${body.trim()}`;
}

/** Rule 4: the draft as the lead receives it (the rep's Send): signature, the booking line only with an email that offers a call. */
export function composeReplyDraft(input: {
  channel: ReplyChannel;
  subject: string;
  body: string;
  ownerName: string;
  companyName: string;
  settings: { email_opt_out_text: string; whatsapp_opt_out_text: string };
  bookingUrl: string | null;
}) {
  const decision = (
    input.channel === "email"
      ? { action: "send_email", subject: input.subject, body: input.body, assetIds: [], nextWakeInDays: 1, reasoning: "reply draft" }
      : { action: "send_whatsapp", body: input.body, assetIds: [], nextWakeInDays: 1, reasoning: "reply draft" }
  ) as SendDecision;
  return composeOutgoing(decision, {
    ownerName: input.ownerName,
    companyName: input.companyName,
    settings: input.settings,
    // The lead wrote to us: never a first WhatsApp (no opt-out line).
    isFirstWhatsApp: false,
    bookingUrl: input.channel === "email" ? input.bookingUrl : null,
    // "check_in" is a call angle: the booking line goes only with a reply that offers a call.
    angle: /call/i.test(input.body) ? "check_in" : null,
  });
}
