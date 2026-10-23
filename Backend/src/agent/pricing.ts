import { z } from "zod";

/** OPENAI_PRICES_JSON: {"<model>": {"inputPer1M": n, "outputPer1M": n}} in USD per million tokens. */
const pricesSchema = z.record(z.object({ inputPer1M: z.number().nonnegative(), outputPer1M: z.number().nonnegative() }).strict());
export type ModelPrices = z.infer<typeof pricesSchema>;

/** Parses OPENAI_PRICES_JSON; blank → no prices. Throws on malformed JSON or values. */
export function parsePrices(raw: string | undefined): ModelPrices {
  if (!raw?.trim()) return {};
  return pricesSchema.parse(JSON.parse(raw));
}

/** USD cost of one call, or null when the model has no configured price (3C-2 refuses to run such a model). */
export function costUsd(prices: ModelPrices, model: string, inputTokens: number, outputTokens: number): number | null {
  const price = prices[model];
  if (!price) return null;
  const cost = (inputTokens * price.inputPer1M + outputTokens * price.outputPer1M) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
