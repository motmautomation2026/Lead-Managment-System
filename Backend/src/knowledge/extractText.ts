import JSZip from "jszip";
import mammoth from "mammoth";
import { getDocumentProxy } from "unpdf";

/** One block of text with where it came from, so chunks can cite a page, slide or heading. */
export interface TextSection {
  text: string;
  page?: number;
  slide?: number;
  heading?: string;
}

export interface ExtractedText {
  text: string;
  sections: TextSection[];
}

/** The file can't be turned into text. Permanent: retrying the same file won't help. */
export class TextExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextExtractionError";
  }
}

type Kind = "pdf" | "docx" | "pptx" | "md" | "txt";

const MIME_KINDS: Record<string, Kind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/plain": "txt",
};
const EXTENSION_KINDS: Record<string, Kind> = { pdf: "pdf", docx: "docx", pptx: "pptx", md: "md", markdown: "md", txt: "txt" };

/** Below this many non-space characters a PDF is treated as having no text layer. */
const MIN_PDF_CHARS = 20;

export function detectKind(mimeType: string | null | undefined, fileName: string | null | undefined): Kind | null {
  const byMime = mimeType ? MIME_KINDS[mimeType.split(";")[0]!.trim().toLowerCase()] : undefined;
  const extension = fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return byMime ?? (extension ? EXTENSION_KINDS[extension] : undefined) ?? null;
}

/** Collapses runs of spaces, trims lines and keeps at most one blank line between paragraphs. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const decodeEntities = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");

/**
 * Drops a header/footer line that repeats as the first or last line on more
 * than half of 3+ pages (digits ignored, so "Page 3" matches "Page 4").
 */
function dropRepeatedHeadersAndFooters(pages: string[][]): string[][] {
  if (pages.length < 3) return pages;
  const key = (line: string | undefined) => (line && line.length <= 100 ? line.replace(/\d+/g, "#").toLowerCase() : null);
  const repeated = (pick: (lines: string[]) => string | undefined) => {
    const counts = new Map<string, number>();
    for (const lines of pages) {
      const k = key(pick(lines));
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, n]) => n > pages.length / 2).map(([k]) => k));
  };
  const headers = repeated((lines) => lines[0]);
  const footers = repeated((lines) => lines[lines.length - 1]);
  return pages.map((lines) => {
    let out = lines;
    if (headers.has(key(out[0]) ?? "")) out = out.slice(1);
    if (footers.has(key(out[out.length - 1]) ?? "")) out = out.slice(0, -1);
    return out;
  });
}

async function extractPdf(buffer: Buffer): Promise<TextSection[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  try {
    const pages: string[][] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const content = await (await pdf.getPage(number)).getTextContent();
      const raw = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
      pages.push(normalizeWhitespace(raw).split("\n").filter(Boolean));
    }
    if (pages.flat().join("").replace(/\s/g, "").length < MIN_PDF_CHARS) {
      throw new TextExtractionError("No readable text found — the PDF may be scanned images.");
    }
    return dropRepeatedHeadersAndFooters(pages).map((lines, i) => ({ text: lines.join("\n"), page: i + 1 }));
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Splits text into sections at heading lines; `isHeading` returns the heading text or null. */
function sectionsByHeading(lines: string[], isHeading: (line: string) => string | null): TextSection[] {
  const sections: TextSection[] = [];
  let current: { heading?: string; lines: string[] } = { lines: [] };
  const flush = () => {
    const text = normalizeWhitespace(current.lines.join("\n"));
    if (text) sections.push(current.heading ? { text, heading: current.heading } : { text });
  };
  for (const line of lines) {
    const heading = isHeading(line);
    if (heading !== null) {
      flush();
      current = { heading, lines: [heading] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

async function extractDocx(buffer: Buffer): Promise<TextSection[]> {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const HEADING = "\u0000H:";
  const text = html
    .replace(/<h[1-6][^>]*>/g, `\n${HEADING}`)
    .replace(/<li[^>]*>/g, "\n- ")
    .replace(/<\/(p|h[1-6]|li|tr|table|ul|ol)>|<br\s*\/?>/g, "\n")
    .replace(/<\/t[dh]>/g, " | ")
    .replace(/<[^>]+>/g, "");
  return sectionsByHeading(decodeEntities(text).split("\n"), (line) => (line.startsWith(HEADING) ? line.slice(HEADING.length).trim() : null));
}

const xmlText = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "g"))].map((m) => decodeEntities(m[1]!));

async function extractPptx(buffer: Buffer): Promise<TextSection[]> {
  const zip = await JSZip.loadAsync(buffer);
  const presentation = await zip.file("ppt/presentation.xml")?.async("string");
  const rels = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string");
  if (!presentation || !rels) throw new TextExtractionError("This PPTX file has no slides.");
  // Slide order comes from presentation.xml, not the slideN file names (which change on reorder).
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [m[0].match(/Id="([^"]+)"/)?.[1], m[0].match(/Target="([^"]+)"/)?.[1]]));
  const order = [...presentation.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => targets.get(m[1]));

  const sections: TextSection[] = [];
  for (const [index, target] of order.entries()) {
    const path = target ? `ppt/${target.replace(/^\.?\//, "").replace(/^\.\.\//, "")}` : "";
    const xml = await zip.file(path)?.async("string");
    if (!xml) continue;
    const paragraphs = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => xmlText(m[1]!, "a:t").join("").trim()).filter(Boolean);
    const text = normalizeWhitespace(paragraphs.join("\n"));
    if (text) sections.push({ text, slide: index + 1, heading: paragraphs[0]! });
  }
  return sections;
}

function stripMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/^\s*[*+]\s+/, "- ")
    .replace(/^>\s?/, "");
}

function extractMarkdown(text: string): TextSection[] {
  return sectionsByHeading(text.replace(/\r\n?/g, "\n").split("\n").map(stripMarkdown), (line) => line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1] ?? null);
}

/**
 * Text and page/slide/heading sections from an uploaded knowledge file:
 * PDF, DOCX, PPTX, Markdown or plain text. Throws TextExtractionError for an
 * unsupported, unreadable or empty file (including a scanned PDF).
 */
export async function extractText(buffer: Buffer, mimeType: string | null | undefined, fileName: string | null | undefined): Promise<ExtractedText> {
  const kind = detectKind(mimeType, fileName);
  if (!kind) throw new TextExtractionError("Unsupported file type. Upload a PDF, DOCX, PPTX, Markdown or text file.");

  let sections: TextSection[];
  try {
    if (kind === "pdf") sections = await extractPdf(buffer);
    else if (kind === "docx") sections = await extractDocx(buffer);
    else if (kind === "pptx") sections = await extractPptx(buffer);
    else if (kind === "md") sections = extractMarkdown(buffer.toString("utf8"));
    else sections = [{ text: normalizeWhitespace(buffer.toString("utf8")) }];
  } catch (error) {
    if (error instanceof TextExtractionError) throw error;
    throw new TextExtractionError(`Couldn't read this ${kind.toUpperCase()} file: ${error instanceof Error ? error.message : String(error)}`);
  }

  sections = sections.filter((section) => section.text);
  if (sections.length === 0) throw new TextExtractionError("No readable text found in this file.");
  return { text: sections.map((section) => section.text).join("\n\n"), sections };
}
