import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/env.js", () => ({ env: { OPENAI_API_KEY: undefined, OPENAI_DECISION_MODEL: undefined, OPENAI_GROUNDING_MODEL: undefined } }));

import { DECISION_JSON_SCHEMA } from "../../src/agent/decisionSchema.js";
import { GROUNDING_JSON_SCHEMA } from "../../src/agent/prompt.js";
import { costUsd, parsePrices } from "../../src/agent/pricing.js";
import { createOpenAIDecisionModel, resolveAgentModels, type ModelCallInput } from "../../src/providers/openai.provider.js";
import { ModelOutputError, PermanentProviderError, ProviderDeferredError, ProviderTimeoutError } from "../../src/providers/provider-errors.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";

const WAIT = { decision: { action: "wait", nextWakeInDays: 3, reasoning: "Too early." } };
const completion = (content: string | null, extra: Record<string, unknown> = {}) => ({
  model: "model-a-2026",
  choices: [{ finish_reason: "stop", message: { content, refusal: null, ...extra } }],
  usage: { prompt_tokens: 1200, completion_tokens: 80 },
});

function fakeClient(...answers: unknown[]) {
  const create = vi.fn(async () => {
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { create, client: { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat"> };
}
const sleep = async () => undefined;
const apiError = (status: number, message: string, code?: string) =>
  OpenAI.APIError.generate(status, { error: { message, ...(code ? { code } : {}) } }, undefined, new Headers());
const input = (schema: Record<string, unknown> = DECISION_JSON_SCHEMA as unknown as Record<string, unknown>): ModelCallInput => ({
  model: "model-a",
  messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
  jsonSchema: { name: "agent_decision", schema },
});

describe("OpenAI decision model", () => {
  it("sends strict JSON-schema structured output and returns the parsed decision with usage", async () => {
    const { create, client } = fakeClient(completion(JSON.stringify(WAIT)));
    const result = await createOpenAIDecisionModel({ client, sleep }).decide(input());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "model-a",
        response_format: { type: "json_schema", json_schema: { name: "agent_decision", schema: DECISION_JSON_SCHEMA, strict: true } },
      }),
    );
    expect(result).toEqual({ json: WAIT.decision, inputTokens: 1200, outputTokens: 80, model: "model-a-2026" });
  });

  it("parses grounding output", async () => {
    const { client } = fakeClient(completion('{"supported":false,"unsupportedClaims":["200 clients"]}'));
    const result = await createOpenAIDecisionModel({ client, sleep }).checkGrounding(input(GROUNDING_JSON_SCHEMA as unknown as Record<string, unknown>));
    expect(result.json).toEqual({ supported: false, unsupportedClaims: ["200 clients"] });
  });

  it("a missing key is a deferral", async () => {
    await expect(createOpenAIDecisionModel().decide(input())).rejects.toMatchObject({ name: "ProviderDeferredError", message: "OpenAI is not configured" });
  });

  it("retries network and 5xx failures up to 2 times", async () => {
    const { create, client } = fakeClient(apiError(503, "down"), new OpenAI.APIConnectionError({ message: "reset" }), completion(JSON.stringify(WAIT)));
    await expect(createOpenAIDecisionModel({ client, sleep }).decide(input())).resolves.toMatchObject({ json: WAIT.decision });
    expect(create).toHaveBeenCalledTimes(3);

    const always = fakeClient(apiError(500, "boom"));
    await expect(createOpenAIDecisionModel({ client: always.client, sleep }).decide(input())).rejects.toBeInstanceOf(ProviderDeferredError);
    expect(always.create).toHaveBeenCalledTimes(3);

    const timeout = fakeClient(new OpenAI.APIConnectionTimeoutError());
    await expect(createOpenAIDecisionModel({ client: timeout.client, sleep }).decide(input())).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it("429 is a deferral; insufficient_quota is permanent; neither is retried", async () => {
    const limited = fakeClient(apiError(429, "slow down"));
    await expect(createOpenAIDecisionModel({ client: limited.client, sleep }).decide(input())).rejects.toBeInstanceOf(ProviderDeferredError);
    expect(limited.create).toHaveBeenCalledTimes(1);
    const quota = fakeClient(apiError(429, "no credit", "insufficient_quota"));
    await expect(createOpenAIDecisionModel({ client: quota.client, sleep }).decide(input())).rejects.toBeInstanceOf(PermanentProviderError);
    const bad = fakeClient(apiError(400, "bad schema"));
    await expect(createOpenAIDecisionModel({ client: bad.client, sleep }).decide(input())).rejects.toBeInstanceOf(PermanentProviderError);
  });

  it.each([
    ["invalid JSON", completion("{not json"), "invalid JSON"],
    ["a schema mismatch", completion('{"decision":{"action":"dance","reasoning":"r"}}'), "didn't match the schema"],
    ["a refusal", completion(null, { refusal: "I can't help with that." }), "refused"],
    ["a cut-off answer", { ...completion("{"), choices: [{ finish_reason: "length", message: { content: "{", refusal: null } }] }, "cut off"],
  ])("%s is a ModelOutputError (a failed attempt)", async (_name, answer, message) => {
    const { client } = fakeClient(answer);
    const error = await createOpenAIDecisionModel({ client, sleep }).decide(input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelOutputError);
    expect((error as Error).message).toContain(message);
  });
});

describe("resolveAgentModels", () => {
  it("prefers the workspace setting, then the env default", () => {
    expect(resolveAgentModels({ decision_model: "ws-big", grounding_model: null }, { decision: "env-big", grounding: "env-small" })).toEqual({
      decisionModel: "ws-big",
      groundingModel: "env-small",
    });
    expect(resolveAgentModels({ decision_model: " ", grounding_model: "ws-small" }, { decision: "env-big" })).toEqual({ decisionModel: "env-big", groundingModel: "ws-small" });
  });

  it("no model anywhere is a deferral, never a hard-coded default", () => {
    expect(() => resolveAgentModels({ decision_model: null, grounding_model: null }, {})).toThrow("No AI model configured");
    expect(() => resolveAgentModels({ decision_model: "ws-big", grounding_model: null }, {})).toThrow(ProviderDeferredError);
    expect(() => resolveAgentModels({ decision_model: null, grounding_model: null })).toThrow("No AI model configured");
  });
});

describe("pricing", () => {
  const prices = parsePrices('{"model-a":{"inputPer1M":2.5,"outputPer1M":10}}');

  it("costs a call per million tokens", () => {
    expect(costUsd(prices, "model-a", 1_000_000, 0)).toBe(2.5);
    expect(costUsd(prices, "model-a", 1200, 80)).toBe(0.0038);
  });

  it("an unknown model has no price", () => {
    expect(costUsd(prices, "model-b", 1000, 100)).toBeNull();
    expect(costUsd(parsePrices(undefined), "model-a", 1, 1)).toBeNull();
  });

  it("rejects malformed price JSON", () => {
    expect(() => parsePrices("{oops")).toThrow();
    expect(() => parsePrices('{"model-a":{"inputPer1M":-1,"outputPer1M":1}}')).toThrow();
    expect(() => parsePrices('{"model-a":{"input":1}}')).toThrow();
  });
});

describe("fake decision model", () => {
  it("answers from queues and records calls", async () => {
    const fake = createFakeDecisionModel({ decisions: [new ProviderDeferredError("busy"), WAIT.decision as never] });
    await expect(fake.decide(input())).rejects.toThrow("busy");
    await expect(fake.decide(input())).resolves.toMatchObject({ json: WAIT.decision, model: "model-a" });
    expect(fake.calls.map((c) => c.kind)).toEqual(["decide", "decide"]);
  });
});
