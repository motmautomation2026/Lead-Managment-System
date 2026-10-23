import OpenAI from "openai";
import { env } from "../env.js";
import { PermanentProviderError, ProviderDeferredError, ProviderTimeoutError } from "./provider-errors.js";

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
