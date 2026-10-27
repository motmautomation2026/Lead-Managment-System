import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import type { GroundingResult } from "../../src/agent/prompt.js";
import type { ReplyClassification } from "../../src/agent/replyClassification.js";
import type { DecisionModel, ModelCallInput, ReplyClassifierModel } from "../../src/providers/openai.provider.js";

type Answer<T> = T | Error;

/**
 * Deterministic stand-in for OpenAI decisions: answers from queues (the last
 * entry repeats), records every call, never touches the network. An Error in a
 * queue is thrown instead.
 */
export function createFakeDecisionModel(
  options: { decisions?: Answer<AgentDecision>[]; grounding?: Answer<GroundingResult>[]; replies?: Answer<ReplyClassification>[]; tokens?: { input: number; output: number } } = {},
) {
  const decisions = [...(options.decisions ?? [{ action: "wait", nextWakeInDays: 3, reasoning: "Nothing new." } as AgentDecision])];
  const grounding = [...(options.grounding ?? [{ supported: true, unsupportedClaims: [] }])];
  const replies = [...(options.replies ?? [{ label: "other", confidence: 0.9 } as ReplyClassification])];
  const tokens = options.tokens ?? { input: 1000, output: 200 };
  const calls: { kind: "decide" | "grounding" | "reply"; input: ModelCallInput }[] = [];
  const next = <T>(queue: Answer<T>[]): T => {
    const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const model: DecisionModel & ReplyClassifierModel & { calls: typeof calls } = {
    calls,
    async decide(input) {
      calls.push({ kind: "decide", input });
      return { json: next(decisions), inputTokens: tokens.input, outputTokens: tokens.output, model: input.model };
    },
    async checkGrounding(input) {
      calls.push({ kind: "grounding", input });
      return { json: next(grounding), inputTokens: tokens.input, outputTokens: tokens.output, model: input.model };
    },
    async classifyReply(input) {
      calls.push({ kind: "reply", input });
      return { json: next(replies), inputTokens: tokens.input, outputTokens: tokens.output, model: input.model };
    },
  };
  return model;
}
