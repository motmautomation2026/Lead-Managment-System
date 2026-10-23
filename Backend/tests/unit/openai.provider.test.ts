import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/env.js", () => ({ env: { OPENAI_API_KEY: undefined, OPENAI_EMBEDDING_MODEL: "text-embedding-3-small" } }));

import { createOpenAIEmbedder, EMBEDDING_DIMENSIONS, retryAfterMs } from "../../src/providers/openai.provider.js";
import { PermanentProviderError, ProviderDeferredError, ProviderTimeoutError } from "../../src/providers/provider-errors.js";
import { fakeEmbedder, fakeVector } from "../helpers/fakeEmbedder.js";

const vector = (seed: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === seed ? 1 : 0));

/** A stand-in for the SDK client: `create` answers from the given queue (values or errors). */
function fakeClient(...answers: unknown[]) {
  const create = vi.fn(async ({ input }: { input: string[] }) => {
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) throw answer;
    if (answer === "ok") return { data: input.map((_, index) => ({ index, embedding: vector(index % EMBEDDING_DIMENSIONS) })).reverse() };
    return answer;
  });
  return { create, client: { embeddings: { create } } as unknown as Pick<OpenAI, "embeddings"> };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};
const embedderWith = (client: Pick<OpenAI, "embeddings">) => createOpenAIEmbedder({ client, model: "text-embedding-3-small", sleep });
const apiError = (status: number, message: string, headers: Record<string, string> = {}, code?: string) =>
  OpenAI.APIError.generate(status, { error: { message, ...(code ? { code } : {}) } }, undefined, new Headers(headers));

describe("OpenAI embedder", () => {
  it("throws ProviderDeferredError when no key is configured (and never builds a client)", async () => {
    const embedder = createOpenAIEmbedder();
    await expect(embedder.embed(["hi"])).rejects.toThrow(new ProviderDeferredError("OpenAI is not configured"));
    expect(embedder.model).toBe("text-embedding-3-small");
    expect(await embedder.embed([])).toEqual([]);
  });

  it("batches 100 inputs per request, keeps input order and asks for 1536 dimensions", async () => {
    const { create, client } = fakeClient("ok");
    const texts = Array.from({ length: 250 }, (_, i) => `text ${i}`);
    const vectors = await embedderWith(client).embed(texts);
    expect(create.mock.calls.map(([body]) => body.input.length)).toEqual([100, 100, 50]);
    expect(create.mock.calls[0]![0]).toMatchObject({ model: "text-embedding-3-small", dimensions: 1536 });
    expect(vectors).toHaveLength(250);
    expect(vectors[0]![0]).toBe(1);
    expect(vectors[1]![1]).toBe(1);
  });

  it("rejects vectors of the wrong size", async () => {
    const { client } = fakeClient({ data: [{ index: 0, embedding: [0.1, 0.2] }] });
    await expect(embedderWith(client).embed(["x"])).rejects.toThrow(
      new PermanentProviderError("OpenAI returned 2-dimension embeddings from text-embedding-3-small; expected 1536."),
    );
  });

  it("retries 5xx and network errors with backoff, then succeeds", async () => {
    sleeps.length = 0;
    const { create, client } = fakeClient(apiError(503, "overloaded"), new OpenAI.APIConnectionError({ message: "socket hang up" }), "ok");
    expect(await embedderWith(client).embed(["x"])).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("gives up after 3 attempts with a retryable error", async () => {
    const server = fakeClient(apiError(500, "boom"));
    await expect(embedderWith(server.client).embed(["x"])).rejects.toThrow(new ProviderDeferredError("OpenAI is unavailable (500): boom"));
    expect(server.create).toHaveBeenCalledTimes(3);
    const timeout = fakeClient(new OpenAI.APIConnectionTimeoutError());
    await expect(embedderWith(timeout.client).embed(["x"])).rejects.toThrow(new ProviderTimeoutError("OpenAI did not respond within 30s"));
  });

  it("defers a 429 with the provider's retry-after, without retrying", async () => {
    const { create, client } = fakeClient(apiError(429, "slow down", { "retry-after": "7" }));
    const error = await embedderWith(client).embed(["x"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderDeferredError);
    expect(error).toMatchObject({ message: "OpenAI rate limit: slow down", retryAfterMs: 7000 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [apiError(401, "bad key"), "OpenAI rejected the API key (401). Check OPENAI_API_KEY."],
    [apiError(403, "region not supported"), "OpenAI denied access (403): region not supported"],
    [apiError(400, "input too long"), "OpenAI rejected the request (400): input too long"],
    [apiError(429, "You exceeded your current quota", {}, "insufficient_quota"), "OpenAI quota exceeded: You exceeded your current quota"],
  ])("maps %s to a permanent error", async (sdkError, message) => {
    const { create, client } = fakeClient(sdkError);
    await expect(embedderWith(client).embed(["x"])).rejects.toThrow(new PermanentProviderError(message));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reads retry-after in its three forms", () => {
    expect(retryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(retryAfterMs({ "retry-after": "3" })).toBe(3000);
    expect(retryAfterMs(new Headers({ "retry-after": new Date(Date.now() + 120_000).toUTCString() }))).toBeGreaterThan(100_000);
    expect(retryAfterMs(undefined)).toBe(60_000);
  });
});

describe("fake embedder (used by tests instead of OpenAI)", () => {
  it("is deterministic, 1536-dimensional and normalised", async () => {
    const [a, b] = await fakeEmbedder.embed(["cold calling works", "cold calling works"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(Math.hypot(...a!)).toBeCloseTo(1);
    const dot = (x: number[], y: number[]) => x.reduce((sum, v, i) => sum + v * y[i]!, 0);
    expect(dot(fakeVector("cold calling"), fakeVector("cold calling scripts"))).toBeGreaterThan(dot(fakeVector("cold calling"), fakeVector("pricing plans")));
  });
});
