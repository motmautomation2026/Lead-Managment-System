import { describe, expect, it } from "vitest";
import { chunkText, countTokens } from "../../src/knowledge/chunkText.js";

const sentences = (count: number, prefix = "Sentence") =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1} explains how outbound calling builds a qualified sales pipeline for industrial buyers.`);

describe("chunkText", () => {
  it("keeps short text as one chunk", () => {
    expect(chunkText("We run outbound campaigns. They work.")).toEqual([
      { index: 0, content: "We run outbound campaigns. They work.", tokenCount: countTokens("We run outbound campaigns. They work."), metadata: {} },
    ]);
  });

  it("splits long text into 500–800 token chunks of whole sentences with ~80 tokens of overlap", () => {
    const all = sentences(300);
    const chunks = chunkText(all.join(" "));
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));

    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.tokenCount).toBe(countTokens(chunk.content));
      expect(chunk.tokenCount).toBeLessThanOrEqual(800);
      if (i < chunks.length - 1) expect(chunk.tokenCount).toBeGreaterThanOrEqual(500);
      // Every piece is a whole original sentence: nothing was cut mid-sentence.
      for (const piece of chunk.content.split(/(?<=\.) /)) expect(all).toContain(piece);
    }
    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1]!.content.split(/(?<=\.) /);
      const next = chunks[i]!.content.split(/(?<=\.) /);
      const overlap = next.filter((sentence) => previous.includes(sentence));
      expect(overlap.length).toBeGreaterThan(0);
      expect(previous.slice(-overlap.length)).toEqual(overlap);
      expect(next.slice(0, overlap.length)).toEqual(overlap);
      const overlapTokens = countTokens(overlap.join(" "));
      expect(overlapTokens).toBeGreaterThan(20);
      expect(overlapTokens).toBeLessThanOrEqual(80);
    }
    // Together the chunks cover every sentence, in order.
    const covered = [...new Set(chunks.flatMap((c) => c.content.split(/(?<=\.) /)))];
    expect(covered).toEqual(all);
  });

  it("never mixes slides, pages or headings in one chunk and keeps their metadata", () => {
    const chunks = chunkText([
      { text: "Why Northbeam\nSenior callers.", slide: 1, heading: "Why Northbeam" },
      { text: "Our results\n3x reply rates.", slide: 2, heading: "Our results" },
      { text: sentences(120, "Page").join(" "), page: 3 },
    ]);
    expect(chunks[0]).toMatchObject({ content: "Why Northbeam\nSenior callers.", metadata: { slide: 1, heading: "Why Northbeam" } });
    expect(chunks[1]).toMatchObject({ content: "Our results\n3x reply rates.", metadata: { slide: 2, heading: "Our results" } });
    const pageChunks = chunks.slice(2);
    expect(pageChunks.length).toBeGreaterThan(1);
    for (const chunk of pageChunks) {
      expect(chunk.metadata).toEqual({ page: 3 });
      expect(chunk.content.startsWith("Page")).toBe(true);
    }
  });

  it("keeps paragraph and line breaks inside a chunk", () => {
    expect(chunkText("First paragraph. Still first.\n\nSecond paragraph\n- a bullet")[0]!.content).toBe(
      "First paragraph. Still first.\n\nSecond paragraph\n- a bullet",
    );
  });

  it("cuts a single sentence only when it alone exceeds the limit", () => {
    const giant = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(`Intro sentence. ${giant}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(800);
    expect(chunks[0]!.content.startsWith("Intro sentence.")).toBe(true);
  });

  it("honours custom limits and is deterministic", () => {
    const text = sentences(40).join(" ");
    const first = chunkText(text, { maxTokens: 100, overlapTokens: 30 });
    expect(chunkText(text, { maxTokens: 100, overlapTokens: 30 })).toEqual(first);
    for (const chunk of first) expect(chunk.tokenCount).toBeLessThanOrEqual(100);
  });

  it("returns nothing for empty sections", () => {
    expect(chunkText([{ text: "   " }, { text: "" }])).toEqual([]);
  });
});
