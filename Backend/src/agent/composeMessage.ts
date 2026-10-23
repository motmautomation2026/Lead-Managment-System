import type { SendDecision } from "./decisionSchema.js";

export interface ComposeOptions {
  ownerName: string;
  companyName: string;
  settings: { email_opt_out_text: string; whatsapp_opt_out_text: string };
  isFirstWhatsApp: boolean;
}

export type OutgoingMessage =
  | { channel: "email"; subject: string; text: string; html: string }
  | { channel: "whatsapp"; text: string };

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

/** Appends the signature (as the lead's owner) and the opt-out line; the AI writes neither. */
export function composeOutgoing(decision: SendDecision, options: ComposeOptions): OutgoingMessage {
  const { ownerName, companyName, settings } = options;
  if (decision.action === "send_whatsapp") {
    let text = `${paragraphs(decision.body).join("\n\n")}\n\n— ${ownerName}, ${companyName}`;
    if (options.isFirstWhatsApp) text += `\n\n${settings.whatsapp_opt_out_text}`;
    return { channel: "whatsapp", text };
  }

  const parts = [...paragraphs(decision.body), `Best regards,\n${ownerName}\n${companyName}`, settings.email_opt_out_text.trim()];
  return {
    channel: "email",
    subject: decision.subject,
    text: parts.join("\n\n"),
    html: parts.map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br>")}</p>`).join("\n"),
  };
}
