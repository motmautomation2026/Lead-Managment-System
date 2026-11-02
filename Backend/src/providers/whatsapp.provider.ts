import type { Queryable } from "../dto.js";
import { baileysRegistry } from "./baileys-registry.js";
import { sourceColumn, type WhatsAppAttachment, type WhatsAppSendSource } from "./baileys.manager.js";

export async function sendWhatsApp(workspaceId: string, input: { source: WhatsAppSendSource; to: string; body: string; attachment?: WhatsAppAttachment; textMentionsAttachment?: boolean }) {
  const manager = await baileysRegistry.getOrCreateManager(workspaceId);
  return manager.sendAction({ source: input.source, phoneE164: input.to, body: input.body, attachment: input.attachment, textMentionsAttachment: input.textMentionsAttachment });
}

/** True once this source's outbound message went out — e.g. a row reclaimed after the worker crashed between sending and recording it. */
export async function wasSentForSource(db: Queryable, source: WhatsAppSendSource): Promise<boolean> {
  const result = await db.query(`select 1 from public.whatsapp_outbound_messages where ${sourceColumn(source)} = $1 and status = 'sent'`, [source.id]);
  return (result.rowCount ?? 0) > 0;
}
