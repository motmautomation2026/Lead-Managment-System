import { createHash } from "node:crypto";
import type { Embedder } from "../../src/providers/openai.provider.js";

const DIMENSIONS = 1536;

/**
 * Deterministic stand-in for OpenAI: a normalised bag-of-words vector (each
 * word hashed to one dimension), so texts sharing more words score as more
 * similar. Never calls the network.
 */
export function fakeVector(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    vector[createHash("sha256").update(word).digest().readUInt32BE(0) % DIMENSIONS]! += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

export const fakeEmbedder: Embedder & { calls: string[][] } = {
  model: "fake-embedding",
  calls: [],
  async embed(texts) {
    this.calls.push(texts);
    return texts.map(fakeVector);
  },
};
