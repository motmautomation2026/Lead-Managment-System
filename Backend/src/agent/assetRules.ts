import type { RuleNote } from "./rules.js";

/**
 * E2g: when the AI may attach an asset. Pure: no I/O.
 *
 * Rule 1 (channel) is a violation: the model picked an asset that doesn't exist, is
 * off or isn't allowed on the channel, so the attempt is regenerated. Rules 2–4 and
 * the count/size limits only DROP the attachment (the message is kept, no
 * regeneration) and say why.
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ASSETS_PER_MESSAGE = { email: 2, whatsapp: 1 } as const;

export type AssetChannel = "email" | "whatsapp";

export interface AgentAssetInfo {
  id: string;
  active: boolean;
  channels: string[];
  sizeBytes: number;
}

/** What rules 2–4 read about the contact. In shadow, drafts never count as sent. */
export interface AssetFacts {
  /** situationOf(ctx).conversationExists: a call/note, meeting/proposal, a replied AI send, or a deal past qualification. */
  conversationExists: boolean;
  /** At least one real message from us: a real AI send, or an email/WhatsApp on the timeline. */
  realMessageSent: boolean;
  /** At least one matched inbound WhatsApp from this contact. */
  whatsappReplied: boolean;
  /** Assets already really sent to this contact (agent_decisions.sent_asset_ids). */
  sentAssetIds: string[];
}

export type AttachmentRemovalReason = "first_message" | "whatsapp_no_reply" | "already_sent" | "count_limit" | "size_limit";

export interface AttachmentRemoval {
  assetId: string;
  reason: AttachmentRemovalReason;
}

export const ATTACHMENT_REMOVAL_TEXT: Record<AttachmentRemovalReason, string> = {
  first_message: "No attachments before a conversation exists",
  whatsapp_no_reply: "WhatsApp attachments only after the contact has replied on WhatsApp",
  already_sent: "Already sent to this contact",
  count_limit: "Too many attachments for this channel",
  size_limit: "Attachments over 10 MB in total",
};

/** Rule 1: every chosen asset exists, is active and allows the channel. */
export function assetViolations(assetIds: string[], channel: AssetChannel, assets: AgentAssetInfo[]): RuleNote[] {
  const notes: RuleNote[] = [];
  for (const id of assetIds) {
    const asset = assets.find((a) => a.id === id);
    if (!asset) notes.push({ rule: "assets", message: `Asset ${id} does not exist.` });
    else if (!asset.active) notes.push({ rule: "assets", message: `Asset ${id} is not active.` });
    else if (!asset.channels.includes(channel)) notes.push({ rule: "assets", message: `Asset ${id} is not allowed on ${channel}.` });
  }
  return notes;
}

/**
 * Rules 2–4 + limits, in this order: never before a conversation (all dropped),
 * WhatsApp only after a WhatsApp reply (all dropped), never the same asset twice,
 * at most 2 (email) / 1 (WhatsApp) — the first ones are kept — and ≤ 10 MB in total
 * (the largest dropped until it fits). `facts` null = unknown → treated as a first message.
 */
export function applyAssetRules(
  assetIds: string[],
  channel: AssetChannel,
  assets: AgentAssetInfo[],
  facts: AssetFacts | null,
): { kept: string[]; removed: AttachmentRemoval[] } {
  const removed: AttachmentRemoval[] = [];
  const unique = [...new Set(assetIds)];
  const dropAll = (reason: AttachmentRemovalReason) => ({ kept: [], removed: unique.map((assetId) => ({ assetId, reason })) });
  if (!unique.length) return { kept: [], removed };
  if (!facts || !(facts.conversationExists || facts.realMessageSent)) return dropAll("first_message");
  if (channel === "whatsapp" && !facts.whatsappReplied) return dropAll("whatsapp_no_reply");

  let kept = unique.filter((id) => {
    if (!facts.sentAssetIds.includes(id)) return true;
    removed.push({ assetId: id, reason: "already_sent" });
    return false;
  });
  const max = MAX_ASSETS_PER_MESSAGE[channel];
  for (const id of kept.slice(max)) removed.push({ assetId: id, reason: "count_limit" });
  kept = kept.slice(0, max);

  const size = (id: string) => assets.find((a) => a.id === id)?.sizeBytes ?? 0;
  while (kept.length && kept.reduce((sum, id) => sum + size(id), 0) > MAX_ATTACHMENT_BYTES) {
    const largest = kept.reduce((a, b) => (size(b) > size(a) ? b : a));
    removed.push({ assetId: largest, reason: "size_limit" });
    kept = kept.filter((id) => id !== largest);
  }
  return { kept, removed };
}

/** E2g rule 6: the attachment's file name = the asset title + the file's extension (characters mail and phones reject removed). */
export function attachmentFileName(title: string, fileName: string | null): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(fileName ?? "")?.[0]?.toLowerCase() ?? "";
  const base = title.replace(/[\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || "attachment";
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
}

/** A send-time problem with one attachment; the message goes out without it. */
export interface AttachmentIssue {
  assetId: string;
  title: string | null;
  reason: string;
}

export const ASSET_GONE_REASON = "The asset was deleted or turned off before sending.";
