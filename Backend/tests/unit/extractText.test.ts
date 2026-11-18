import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectKind, extractText, normalizeWhitespace, TextExtractionError } from "../../src/knowledge/extractText.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/knowledge/${name}`, import.meta.url));
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("extractText", () => {
  it("reads a PDF page by page and drops the repeated header and page-number footer", async () => {
    const result = await extractText(fixture("sample.pdf"), "application/pdf", "sample.pdf");
    expect(result.sections).toEqual([
      { text: "Our process starts with research.", page: 1 },
      { text: "Then we run outreach campaigns.", page: 2 },
      { text: "Finally we hand over warm meetings.", page: 3 },
    ]);
    expect(result.text).toBe("Our process starts with research.\n\nThen we run outreach campaigns.\n\nFinally we hand over warm meetings.");
  });

  it("rejects a PDF with no text layer", async () => {
    await expect(extractText(fixture("scanned.pdf"), "application/pdf", "scan.pdf")).rejects.toThrow(
      new TextExtractionError("No readable text found — the PDF may be scanned images."),
    );
  });

  it("reads DOCX sections by heading", async () => {
    const result = await extractText(fixture("sample.docx"), DOCX, "case.docx");
    expect(result.sections).toEqual([
      { text: "Case study: Acme\nAcme doubled its pipeline in 90 days.", heading: "Case study: Acme" },
      { text: "Results\n40 meetings & 6 new clients.", heading: "Results" },
    ]);
  });

  it("reads PPTX slides in presentation order, titled by their first line", async () => {
    const result = await extractText(fixture("sample.pptx"), PPTX, "deck.pptx");
    expect(result.sections).toEqual([
      { text: "Why Northbeam\nSenior callers,\nno scripts.", slide: 1, heading: "Why Northbeam" },
      { text: "Our results\n3x reply rates\n<30 day ramp", slide: 2, heading: "Our results" },
    ]);
  });

  it("reads Markdown sections by heading and strips formatting", async () => {
    const result = await extractText(fixture("sample.md"), "text/markdown", "services.md");
    expect(result.sections).toEqual([
      { text: "Services\n\nWe offer lead generation and cold calling.", heading: "Services" },
      { text: "Pricing\n\nPlans start at ₹50,000 per month.\n\n- Setup in two weeks\n- Cancel anytime", heading: "Pricing" },
    ]);
  });

  it("reads plain text with normalised whitespace", async () => {
    const result = await extractText(fixture("sample.txt"), "text/plain", "notes.txt");
    expect(result).toEqual({
      text: "Northbeam helps B2B companies find buyers.\n\nWe run outbound campaigns.",
      sections: [{ text: "Northbeam helps B2B companies find buyers.\n\nWe run outbound campaigns." }],
    });
  });

  it("detects the type from the extension when the MIME type is generic", async () => {
    expect(detectKind("application/octet-stream", "Deck.PPTX")).toBe("pptx");
    expect(detectKind("text/plain; charset=utf-8", null)).toBe("txt");
    expect(detectKind("image/png", "photo.png")).toBeNull();
    const result = await extractText(fixture("sample.docx"), "application/octet-stream", "case.docx");
    expect(result.sections).toHaveLength(2);
  });

  it.each([
    [Buffer.from("x"), "image/png", "photo.png", "Unsupported file type. Upload a PDF, DOCX, PPTX, Markdown or text file."],
    [Buffer.from("   \n\n "), "text/plain", "empty.txt", "No readable text found in this file."],
  ])("rejects %s %s", async (buffer, mime, name, message) => {
    await expect(extractText(buffer, mime, name)).rejects.toThrow(new TextExtractionError(message));
  });

  it("wraps a corrupt file in a clear error", async () => {
    await expect(extractText(Buffer.from("not a zip"), DOCX, "broken.docx")).rejects.toThrow(/^Couldn't read this DOCX file: /);
  });
});

describe("normalizeWhitespace", () => {
  it("collapses spaces and blank lines", () => {
    expect(normalizeWhitespace("  a\t\tb   c \r\n\r\n\r\n\n d  ")).toBe("a b c\n\nd");
  });
});
