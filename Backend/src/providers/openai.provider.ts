import OpenAI from "openai";
import { env } from "../env.js";
import { ModelOutputError, PermanentProviderError, ProviderDeferredError, ProviderTimeoutError } from "./provider-errors.js";
import { parseModelOutput, type AgentDecision } from "../agent/decisionSchema.js";
import { parseGroundingOutput, type ChatMessage, type GroundingResult } from "../agent/prompt.js";
import { parseReplyClassification, type ReplyClassification } from "../agent/replyClassification.js";

/** kb_chunks.embedding is vector(1536): every model must produce exactly this many dimensions. */
export const EMBEDDING_DIMENSIONS = 1536;
const BATCH_SIZE = 100;
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_AFTER_MS = 60_000;

/** Turns texts into embedding vectors (same order). Injected so tests use a deterministic fake. */
export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

type EmbeddingsClient = Pick<OpenAI, "embeddings">;

export interface OpenAIEmbedderOptions {
  apiKey?: string | undefined;
  model?: string;
  /** For tests: a stand-in for the SDK client. */
  client?: EmbeddingsClient;
  /** For tests: replaces the backoff wait. */
  sleep?: (ms: number) => Promise<void>;
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === "string" ? value : null;
}

/** Milliseconds from retry-after-ms / retry-after (seconds or an HTTP date), else the default. */
export function retryAfterMs(headers: unknown): number {
  const ms = Number(headerValue(headers, "retry-after-ms"));
  if (ms > 0) return ms;
  const raw = headerValue(headers, "retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (seconds > 0) return seconds * 1000;
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.max(1000, at - Date.now());
  }
  return DEFAULT_RETRY_AFTER_MS;
}

/** Maps an SDK failure to our provider errors, and says whether the same request is worth retrying now. */
function classify(error: unknown): { retry: boolean; error: unknown } {
  if (error instanceof PermanentProviderError) return { retry: false, error };
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return { retry: true, error: new ProviderTimeoutError(`OpenAI did not respond within ${TIMEOUT_MS / 1000}s`) };
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return { retry: true, error: new ProviderDeferredError(`Couldn't reach OpenAI: ${error.message}`) };
  }
  if (!(error instanceof OpenAI.APIError)) return { retry: false, error };

  const status = error.status ?? 0;
  const detail = (error.error as { message?: string } | undefined)?.message ?? error.message;
  if (status === 429) {
    // An empty quota won't fix itself by waiting; a rate limit will.
    if (error.code === "insufficient_quota") return { retry: false, error: new PermanentProviderError(`OpenAI quota exceeded: ${detail}`) };
    return { retry: false, error: new ProviderDeferredError(`OpenAI rate limit: ${detail}`, retryAfterMs(error.headers)) };
  }
  if (status >= 500) return { retry: true, error: new ProviderDeferredError(`OpenAI is unavailable (${status}): ${detail}`) };
  if (status === 401) return { retry: false, error: new PermanentProviderError("OpenAI rejected the API key (401). Check OPENAI_API_KEY.") };
  if (status === 403) return { retry: false, error: new PermanentProviderError(`OpenAI denied access (403): ${detail}`) };
  return { retry: false, error: new PermanentProviderError(`OpenAI rejected the request (${status}): ${detail}`) };
}

async function embedBatch(client: EmbeddingsClient, model: string, input: string[], sleep: (ms: number) => Promise<void>): Promise<number[][]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await client.embeddings.create({
        model,
        input,
        // text-embedding-3 models can shorten their output; older ones are fixed (and checked below).
        ...(model.startsWith("text-embedding-3") ? { dimensions: EMBEDDING_DIMENSIONS } : {}),
      });
      const vectors = [...response.data].sort((a, b) => a.index - b.index).map((item) => Array.from(item.embedding as ArrayLike<number>));
      if (vectors.length !== input.length) {
        throw new PermanentProviderError(`OpenAI returned ${vectors.length} embeddings for ${input.length} inputs.`);
      }
      const wrong = vectors.find((vector) => vector.length !== EMBEDDING_DIMENSIONS);
      if (wrong) {
        throw new PermanentProviderError(`OpenAI returned ${wrong.length}-dimension embeddings from ${model}; expected ${EMBEDDING_DIMENSIONS}.`);
      }
      return vectors;
    } catch (error) {
      const outcome = classify(error);
      if (!outcome.retry || attempt >= MAX_ATTEMPTS) throw outcome.error;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

/**
 * Embeds texts with OpenAI, in batches of up to 100, 30 s per request,
 * retrying 5xx and network failures with backoff (1 s, 2 s). A missing key
 * throws ProviderDeferredError("OpenAI is not configured"). Server-only.
 */
export function createOpenAIEmbedder(options: OpenAIEmbedderOptions = {}): Embedder {
  const apiKey = options.apiKey ?? env.OPENAI_API_KEY;
  const model = options.model ?? env.OPENAI_EMBEDDING_MODEL;
  const client = options.client ?? (apiKey ? new OpenAI({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 }) : null);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    model,
    async embed(texts) {
      if (texts.length === 0) return [];
      // Configuration doesn't change by itself: check back in 10 minutes, not every minute.
      if (!client) throw new ProviderDeferredError("OpenAI is not configured", 10 * 60_000);
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += BATCH_SIZE) {
        vectors.push(...(await embedBatch(client, model, texts.slice(start, start + BATCH_SIZE), sleep)));
      }
      return vectors;
    },
  };
}

let defaultEmbedder: Embedder | undefined;

/** The environment-configured OpenAI embedder (one per process). */
export function getDefaultEmbedder(): Embedder {
  defaultEmbedder ??= createOpenAIEmbedder();
  return defaultEmbedder;
}

/** Embeds with the environment-configured OpenAI embedder. */
export function embedTexts(texts: string[]): Promise<number[][]> {
  return getDefaultEmbedder().embed(texts);
}

// --- AI agent decisions ------------------------------------------------------

export interface ModelCallInput {
  model: string;
  messages: ChatMessage[];
  /** Strict structured output: DECISION_JSON_SCHEMA or GROUNDING_JSON_SCHEMA. */
  jsonSchema: { name: string; schema: Record<string, unknown> };
}

export interface ModelCallResult<T> {
  /** The parsed, schema-validated output. */
  json: T;
  inputTokens: number;
  outputTokens: number;
  /** The model that answered (as the API reports it). */
  model: string;
}

/**
 * The agent's model calls. Injected so tests never call OpenAI
 * (tests/helpers/fakeDecisionModel.ts). Throws ProviderDeferredError (no key,
 * rate limit, outage), PermanentProviderError (quota, auth, bad request) or
 * ModelOutputError (invalid JSON / schema mismatch / refusal: a failed attempt).
 */
export interface DecisionModel {
  decide(input: ModelCallInput): Promise<ModelCallResult<AgentDecision>>;
  checkGrounding(input: ModelCallInput): Promise<ModelCallResult<GroundingResult>>;
}

/** D4a: labels one inbound WhatsApp reply (REPLY_CLASSIFICATION_JSON_SCHEMA). Same errors as DecisionModel. */
export interface ReplyClassifierModel {
  classifyReply(input: ModelCallInput): Promise<ModelCallResult<ReplyClassification>>;
}

type ChatClient = Pick<OpenAI, "chat">;

export interface OpenAIDecisionModelOptions {
  apiKey?: string | undefined;
  /** For tests: a stand-in for the SDK client. */
  client?: ChatClient;
  /** For tests: replaces the backoff wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Workspace setting first, then the env default; never a hard-coded name. */
export function resolveAgentModels(
  settings: { decision_model: string | null; grounding_model: string | null },
  defaults: { decision?: string | undefined; grounding?: string | undefined } = { decision: env.OPENAI_DECISION_MODEL, grounding: env.OPENAI_GROUNDING_MODEL },
): { decisionModel: string; groundingModel: string } {
  const decisionModel = settings.decision_model?.trim() || defaults.decision?.trim();
  const groundingModel = settings.grounding_model?.trim() || defaults.grounding?.trim();
  // Configuration doesn't change by itself: check back in 10 minutes.
  if (!decisionModel || !groundingModel) throw new ProviderDeferredError("No AI model configured", 10 * 60_000);
  return { decisionModel, groundingModel };
}

async function structuredCall<T>(client: ChatClient, input: ModelCallInput, parse: (json: unknown) => T, sleep: (ms: number) => Promise<void>): Promise<ModelCallResult<T>> {
  for (let attempt = 1; ; attempt++) {
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await client.chat.completions.create({
        model: input.model,
        messages: input.messages,
        stream: false,
        response_format: { type: "json_schema", json_schema: { name: input.jsonSchema.name, schema: input.jsonSchema.schema, strict: true } },
      });
    } catch (error) {
      const outcome = classify(error);
      if (!outcome.retry || attempt >= MAX_ATTEMPTS) throw outcome.error;
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    const choice = completion.choices[0];
    if (!choice) throw new ModelOutputError("The model returned no answer.");
    if (choice.message.refusal) throw new ModelOutputError(`The model refused: ${choice.message.refusal}`);
    if (choice.finish_reason === "length") throw new ModelOutputError("The model's answer was cut off (length limit).");
    let json: T;
    try {
      json = parse(choice.message.content ?? "");
    } catch (error) {
      const reason = error instanceof SyntaxError ? "invalid JSON" : "output didn't match the schema";
      throw new ModelOutputError(`The model's ${reason}.`);
    }
    return {
      json,
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
      model: completion.model || input.model,
    };
  }
}

/**
 * OpenAI chat completions with strict JSON-schema output, 30 s per request,
 * up to 2 retries on network / 5xx failures (1 s, 2 s). A missing key throws
 * ProviderDeferredError("OpenAI is not configured"). Server-only.
 */
export function createOpenAIDecisionModel(options: OpenAIDecisionModelOptions = {}): DecisionModel & ReplyClassifierModel {
  const apiKey = options.apiKey ?? env.OPENAI_API_KEY;
  const client = options.client ?? (apiKey ? new OpenAI({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 }) : null);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const call = <T>(input: ModelCallInput, parse: (json: unknown) => T) => {
    if (!client) throw new ProviderDeferredError("OpenAI is not configured", 10 * 60_000);
    return structuredCall(client, input, parse, sleep);
  };
  return {
    decide: async (input) => call(input, parseModelOutput),
    checkGrounding: async (input) => call(input, parseGroundingOutput),
    classifyReply: async (input) => call(input, parseReplyClassification),
  };
}
