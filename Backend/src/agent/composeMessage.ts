import type { SendDecision } from "./decisionSchema.js";
import { CALL_ANGLES, type Angle } from "./stagePlan.js";

export interface ComposeOptions {
  ownerName: string;
  companyName: string;
  settings: { email_opt_out_text: string; whatsapp_opt_out_text: string };
  isFirstWhatsApp: boolean;
  /** E3b-1 rule 5: the owner's booking page (profiles.booking_url) and the message's angle; the link goes with call angles. */
  bookingUrl?: string | null;
  angle?: string | null;
}

export type OutgoingMessage =
  | { channel: "email"; subject: string; text: string; html: string; bookingLinkAdded: boolean }
  | { channel: "whatsapp"; text: string; bookingLinkAdded: boolean };

/** E3b-1 rule 5: the booking line for a message that asks for a call; never on a first WhatsApp (E1: no links). */
export function bookingLine(channel: "email" | "whatsapp", options: Pick<ComposeOptions, "bookingUrl" | "angle" | "isFirstWhatsApp">): string | null {
  if (!options.bookingUrl || !options.angle || !CALL_ANGLES.includes(options.angle as Angle)) return null;
  if (channel === "whatsapp") return options.isFirstWhatsApp ? null : `You can also pick a time here: ${options.bookingUrl}`;
  return `If it's easier, you can pick a time here: ${options.bookingUrl}`;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Plain text → paragraphs on blank lines; single line breaks stay inside a paragraph. */
function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Appends the booking line (E3b-1), the signature (as the lead's owner) and the opt-out line; the AI writes none of them. */
export function composeOutgoing(decision: SendDecision, options: ComposeOptions): OutgoingMessage {
  const { ownerName, companyName, settings } = options;
  if (decision.action === "send_whatsapp") {
    const booking = bookingLine("whatsapp", options);
    // E3b-1 rule 8: "<first name>, <company>" on its own line, no leading dash.
    const firstName = ownerName.trim().split(/\s+/)[0] || ownerName;
    let text = [...paragraphs(decision.body), ...(booking ? [booking] : [])].join("\n\n") + `\n\n${firstName}, ${companyName}`;
    if (options.isFirstWhatsApp) text += `\n\n${settings.whatsapp_opt_out_text}`;
    return { channel: "whatsapp", text, bookingLinkAdded: Boolean(booking) };
  }

  const booking = bookingLine("email", options);
  const parts = [...paragraphs(decision.body), ...(booking ? [booking] : []), `Best regards,\n${ownerName}\n${companyName}`, settings.email_opt_out_text.trim()];
  return {
    channel: "email",
    subject: decision.subject,
    text: parts.join("\n\n"),
    html: parts.map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br>")}</p>`).join("\n"),
    bookingLinkAdded: Boolean(booking),
  };
}
