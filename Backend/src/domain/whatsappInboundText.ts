import { normalizeMessageContent, type proto } from "baileys";

export const INBOUND_TEXT_MAX_CHARS = 4_000;

/**
 * The human-readable text of an inbound WhatsApp message: plain/extended text,
 * an image/video/document caption, or the label of a tapped button / list row.
 * Anything else (audio, sticker, location, reaction, …) → null. Wrappers
 * (ephemeral, view-once, document-with-caption) are unwrapped first.
 * Capped at 4,000 characters (code points, so an emoji is never split).
 */
export function extractInboundText(message: proto.IMessage | null | undefined): { text: string | null; truncated: boolean } {
  const m = normalizeMessageContent(message);
  const raw =
    m?.conversation ??
    m?.extendedTextMessage?.text ??
    m?.imageMessage?.caption ??
    m?.videoMessage?.caption ??
    m?.documentMessage?.caption ??
    m?.buttonsResponseMessage?.selectedDisplayText ??
    m?.templateButtonReplyMessage?.selectedDisplayText ??
    m?.listResponseMessage?.title;
  const chars = Array.from(raw?.trim() ?? "");
  if (chars.length === 0) return { text: null, truncated: false };
  const truncated = chars.length > INBOUND_TEXT_MAX_CHARS;
  return { text: truncated ? chars.slice(0, INBOUND_TEXT_MAX_CHARS).join("") : chars.join(""), truncated };
}
