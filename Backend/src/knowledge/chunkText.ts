import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import type { TextSection } from "./extractText.js";

// cl100k_base is the tokenizer of OpenAI's text-embedding-3 models.
const encoder = new Tiktoken(cl100k_base);

export const countTokens = (text: string): number => encoder.encode(text).length;

export interface ChunkOptions {
  /** Hard upper bound per chunk, overlap included. */
  maxTokens?: number;
  /** Tokens of trailing whole sentences repeated at the start of the next chunk in the same section. */
  overlapTokens?: number;
}

export interface ChunkMetadata {
  page?: number;
  slide?: number;
  heading?: string;
}

export interface TextChunk {
  index: number;
  content: string;
  tokenCount: number;
  metadata: ChunkMetadata;
}

export const CHUNK_DEFAULTS = { maxTokens: 800, overlapTokens: 80 } as const;

/** A sentence, line or paragraph, with the separator that came before it. */
interface Unit {
  sep: string;
  text: string;
  tokens: number;
}

const SENTENCE_END = /(?<=[.!?…])\s+(?=\S)/;

function unitsOf(text: string, maxTokens: number): Unit[] {
  const units: Unit[] = [];
  const push = (sep: string, piece: string) => {
    const tokens = countTokens(sep + piece);
    if (tokens <= maxTokens) {
      units.push({ sep, text: piece, tokens });
      return;
    }
    // A single "sentence" longer than a chunk: the only case where we cut mid-sentence.
    const ids = encoder.encode(piece);
    for (let start = 0; start < ids.length; start += maxTokens) {
      const slice = encoder.decode(ids.slice(start, start + maxTokens));
      units.push({ sep: start === 0 ? sep : "", text: slice, tokens: countTokens(slice) });
    }
  };
  text.split(/\n{2,}/).forEach((paragraph, p) =>
    paragraph.split("\n").forEach((line, l) =>
      line
        .split(SENTENCE_END)
        .filter((sentence) => sentence.trim())
        .forEach((sentence, s) => push(s > 0 ? " " : l > 0 ? "\n" : p > 0 ? "\n\n" : "", sentence)),
    ),
  );
  return units;
}

const join = (units: Unit[]) => units.map((unit, i) => (i === 0 ? "" : unit.sep) + unit.text).join("");
const sum = (units: Unit[]) => units.reduce((total, unit) => total + unit.tokens, 0);

/**
 * Splits text into embedding chunks of at most `maxTokens` (default 800; long
 * text fills chunks to roughly 500–800), each repeating about `overlapTokens`
 * (default 80) of whole trailing sentences from the previous chunk. A chunk
 * never spans two sections (page, slide or heading block) and never cuts a
 * sentence unless that sentence alone is longer than a chunk. Deterministic.
 */
export function chunkText(input: string | TextSection[], options: ChunkOptions = {}): TextChunk[] {
  const { maxTokens, overlapTokens } = { ...CHUNK_DEFAULTS, ...options };
  const sections: TextSection[] = typeof input === "string" ? [{ text: input }] : input;
  const chunks: TextChunk[] = [];

  for (const section of sections) {
    const metadata: ChunkMetadata = {
      ...(section.page !== undefined ? { page: section.page } : {}),
      ...(section.slide !== undefined ? { slide: section.slide } : {}),
      ...(section.heading !== undefined ? { heading: section.heading } : {}),
    };
    const emit = (units: Unit[]) => {
      const content = join(units).trim();
      if (content) chunks.push({ index: chunks.length, content, tokenCount: countTokens(content), metadata });
    };

    let current: Unit[] = [];
    // Summed per-unit counts slightly over-estimate the joined text, so the bound holds.
    for (const unit of unitsOf(section.text, maxTokens)) {
      if (current.length > 0 && sum(current) + unit.tokens > maxTokens) {
        emit(current);
        const overlap: Unit[] = [];
        for (let i = current.length - 1; i >= 0 && sum(overlap) + current[i]!.tokens <= overlapTokens; i--) overlap.unshift(current[i]!);
        while (overlap.length > 0 && sum(overlap) + unit.tokens > maxTokens) overlap.shift();
        current = overlap;
      }
      current.push(unit);
    }
    emit(current);
  }
  return chunks;
}
