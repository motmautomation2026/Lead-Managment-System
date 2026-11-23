import { z } from "zod";
import { parseModelSetting } from "./modelSetting.js";

/** OPENAI_PRICES_JSON: {"<model>": {"inputPer1M": n, "cachedInputPer1M": n (optional), "outputPer1M": n}} in USD per million tokens. */
const pricesSchema = z.record(z.object({ inputPer1M: z.number().nonnegative(), cachedInputPer1M: z.number().nonnegative().optional(), outputPer1M: z.number().nonnegative() }).strict());
export type ModelPrices = z.infer<typeof pricesSchema>;

/** Built-in prices (USD per 1M tokens); OPENAI_PRICES_JSON overrides them. SUM-1: the summary model. */
export const DEFAULT_PRICES: ModelPrices = { "gpt-5.4-nano": { inputPer1M: 0.2, cachedInputPer1M: 0.02, outputPer1M: 1.25 } };

/** Parses OPENAI_PRICES_JSON over DEFAULT_PRICES; blank → the defaults. Throws on malformed JSON or values. */
export function parsePrices(raw: string | undefined): ModelPrices {
  if (!raw?.trim()) return { ...DEFAULT_PRICES };
  return { ...DEFAULT_PRICES, ...pricesSchema.parse(JSON.parse(raw)) };
}

/** The price of a model setting ("gpt-5.4-mini@low" is priced as gpt-5.4-mini). */
export const priceOf = (prices: ModelPrices, setting: string) => prices[parseModelSetting(setting).model];

/**
 * USD cost of one call, or null when the model has no configured price (3C-2 refuses to run such a model).
 * `cachedInputTokens` are part of `inputTokens`, charged at cachedInputPer1M (full input price without one).
 */
export function costUsd(prices: ModelPrices, model: string, inputTokens: number, outputTokens: number, cachedInputTokens = 0): number | null {
  const price = priceOf(prices, model);
  if (!price) return null;
  const cached = Math.min(cachedInputTokens, inputTokens);
  const cost = ((inputTokens - cached) * price.inputPer1M + cached * (price.cachedInputPer1M ?? price.inputPer1M) + outputTokens * price.outputPer1M) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
