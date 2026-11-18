import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/env.js", () => ({ env: { OPENAI_API_KEY: undefined, OPENAI_DECISION_MODEL: undefined, OPENAI_GROUNDING_MODEL: undefined } }));

import { DECISION_JSON_SCHEMA } from "../../src/agent/decisionSchema.js";
import { GROUNDING_JSON_SCHEMA } from "../../src/agent/prompt.js";
import { costUsd, parsePrices, priceOf } from "../../src/agent/pricing.js";
import { MAX_COMPLETION_TOKENS, modelParams, modelSettingProblem, parseModelSetting } from "../../src/agent/modelSetting.js";
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
    expect(result).toEqual({ json: WAIT.decision, inputTokens: 1200, cachedInputTokens: 0, outputTokens: 80, model: "model-a-2026" });
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

describe("model settings (E3a)", () => {
  it("parses an optional @effort; an unknown effort stays in the name", () => {
    expect(parseModelSetting("gpt-5.4-mini")).toEqual({ model: "gpt-5.4-mini", effort: null });
    expect(parseModelSetting("gpt-5.4-mini@low")).toEqual({ model: "gpt-5.4-mini", effort: "low" });
    expect(parseModelSetting("gpt-5.4-mini@fast")).toEqual({ model: "gpt-5.4-mini@fast", effort: null });
  });

  it("request params per model family", () => {
    expect(modelParams("gpt-4.1")).toEqual({ model: "gpt-4.1" });
    expect(modelParams("gpt-4.1-mini")).toEqual({ model: "gpt-4.1-mini" });
    expect(modelParams("gpt-5.4-mini")).toEqual({ model: "gpt-5.4-mini", reasoning_effort: "none", max_completion_tokens: MAX_COMPLETION_TOKENS });
    expect(modelParams("gpt-5.4-mini@low")).toEqual({ model: "gpt-5.4-mini", reasoning_effort: "low", max_completion_tokens: MAX_COMPLETION_TOKENS });
    expect(modelParams("gpt-5-mini").reasoning_effort).toBe("minimal");
    expect(modelParams("o3-mini").reasoning_effort).toBe("low");
  });

  it("the provider sends them, never a temperature, and strips the effort from the model name", async () => {
    const { create, client } = fakeClient(completion(JSON.stringify(WAIT)));
    await createOpenAIDecisionModel({ client, sleep }).decide({ ...input(), model: "gpt-5.4-mini@low" });
    const sent = (create.mock.calls as unknown as [Record<string, unknown>][])[0]![0];
    expect(sent).toMatchObject({ model: "gpt-5.4-mini", reasoning_effort: "low", max_completion_tokens: MAX_COMPLETION_TOKENS, response_format: { type: "json_schema" } });
    expect(sent).not.toHaveProperty("temperature");
    expect(sent).not.toHaveProperty("max_tokens");
  });

  it("reports cached input tokens from the usage", async () => {
    const { client } = fakeClient({ ...completion(JSON.stringify(WAIT)), usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 1024 } } });
    expect((await createOpenAIDecisionModel({ client, sleep }).decide(input())).cachedInputTokens).toBe(1024);
  });

  it("the Settings field: names and efforts, not an effort on a model without reasoning", () => {
    for (const ok of ["gpt-5.4-mini", "gpt-5.4-mini@low", "gpt-4.1", "ft:gpt-4.1:org:x:1"]) expect(modelSettingProblem(ok)).toBeNull();
    expect(modelSettingProblem("gpt-4.1@low")).toContain("doesn't take a reasoning effort");
    expect(modelSettingProblem("gpt-5.4-mini@fast")).toContain("Use a model name");
  });
});

describe("pricing", () => {
  const prices = parsePrices('{"model-a":{"inputPer1M":2.5,"outputPer1M":10}}');

  it("costs a call per million tokens", () => {
    expect(costUsd(prices, "model-a", 1_000_000, 0)).toBe(2.5);
    expect(costUsd(prices, "model-a", 1200, 80)).toBe(0.0038);
  });

  it("E3a: cached input at cachedInputPer1M; without one at the input price; an effort doesn't change the price", () => {
    const three = parsePrices('{"gpt-5.4-mini":{"inputPer1M":0.75,"cachedInputPer1M":0.075,"outputPer1M":4.5}}');
    expect(costUsd(three, "gpt-5.4-mini", 1_000_000, 0, 800_000)).toBe(0.21);
    expect(costUsd(three, "gpt-5.4-mini@low", 1_000_000, 0)).toBe(0.75);
    expect(costUsd(prices, "model-a", 1_000_000, 0, 800_000)).toBe(2.5);
    expect(priceOf(three, "gpt-5.4-mini@low")).toEqual(three["gpt-5.4-mini"]);
    expect(priceOf(three, "gpt-5.4-mini@fast")).toBeUndefined();
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
