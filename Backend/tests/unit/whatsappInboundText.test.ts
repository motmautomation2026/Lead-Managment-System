import { describe, expect, it } from "vitest";
import { extractInboundText, INBOUND_TEXT_MAX_CHARS } from "../../src/domain/whatsappInboundText.js";

const text = (message: unknown) => extractInboundText(message as never);

describe("extractInboundText", () => {
  it("reads plain and extended text", () => {
    expect(text({ conversation: "  Hello there  " })).toEqual({ text: "Hello there", truncated: false });
    expect(text({ extendedTextMessage: { text: "See https://x.y" } })).toEqual({ text: "See https://x.y", truncated: false });
  });

  it("reads image, video and document captions (also inside wrappers)", () => {
    expect(text({ imageMessage: { caption: "our brochure" } }).text).toBe("our brochure");
    expect(text({ videoMessage: { caption: "demo" } }).text).toBe("demo");
    expect(text({ documentMessage: { caption: "PO attached" } }).text).toBe("PO attached");
    expect(text({ documentWithCaptionMessage: { message: { documentMessage: { caption: "signed copy" } } } }).text).toBe("signed copy");
    expect(text({ ephemeralMessage: { message: { conversation: "disappearing" } } }).text).toBe("disappearing");
    expect(text({ viewOnceMessageV2: { message: { imageMessage: { caption: "once" } } } }).text).toBe("once");
  });

  it("reads button and list replies", () => {
    expect(text({ buttonsResponseMessage: { selectedDisplayText: "Yes, call me" } }).text).toBe("Yes, call me");
    expect(text({ templateButtonReplyMessage: { selectedDisplayText: "Interested" } }).text).toBe("Interested");
    expect(text({ listResponseMessage: { title: "Next week" } }).text).toBe("Next week");
  });

  it("returns null for non-text messages and blank text", () => {
    for (const message of [
      { audioMessage: { seconds: 4 } },
      { stickerMessage: {} },
      { locationMessage: { degreesLatitude: 19, degreesLongitude: 72 } },
      { reactionMessage: { text: "👍" } },
      { imageMessage: {} },
      { conversation: "   " },
      null,
      undefined,
    ]) {
      expect(text(message)).toEqual({ text: null, truncated: false });
    }
  });

  it("keeps emoji and Hinglish intact", () => {
    const hinglish = "Haan ji, kal call kar lo 🙏 — मैं free हूँ";
    expect(text({ conversation: hinglish })).toEqual({ text: hinglish, truncated: false });
  });

  it("caps at 4,000 characters without splitting an emoji", () => {
    expect(text({ conversation: "a".repeat(INBOUND_TEXT_MAX_CHARS) })).toEqual({ text: "a".repeat(INBOUND_TEXT_MAX_CHARS), truncated: false });
    const long = text({ conversation: "😀".repeat(INBOUND_TEXT_MAX_CHARS + 10) });
    expect(long.truncated).toBe(true);
    expect(Array.from(long.text!)).toHaveLength(INBOUND_TEXT_MAX_CHARS);
    expect(long.text!.endsWith("😀")).toBe(true);
  });
});
