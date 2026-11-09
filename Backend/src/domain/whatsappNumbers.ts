import { warmupCap } from "./whatsappSafety.js";

/**
 * E4a: several WhatsApp numbers per workspace, one sticky number per lead. Pure rules only;
 * services gather the inputs (services/whatsappNumbers.service.ts).
 */

export interface NumberCandidate {
  id: string;
  label: string;
  ownerUserId: string | null;
  /** status = 'connected'. */
  connected: boolean;
  /** The number's own pause (`enabled` = false) or the workspace master switch off. */
  paused: boolean;
  removed: boolean;
  dailyCap: number;
  /** warmupDayFor(paired_at) — null = fully warmed. */
  warmupDay: number | null;
  sentToday: number;
  newChatsToday: number;
  pairedAt: Date | null;
}

/** Sends left today after warm-up. */
export function roomToday(n: NumberCandidate): number {
  return Math.max(0, warmupCap(n.warmupDay, n.dailyCap) - n.sentToday);
}

const usable = (n: NumberCandidate) => !n.removed && n.connected && !n.paused;

/** Most room first, then fewest new chats today, then the oldest pairing (null = paired before E1 = oldest). */
function healthiest(candidates: NumberCandidate[]): NumberCandidate | undefined {
  return candidates
    .filter((n) => usable(n) && roomToday(n) > 0)
    .sort(
      (a, b) =>
        roomToday(b) - roomToday(a) ||
        a.newChatsToday - b.newChatsToday ||
        (a.pairedAt?.getTime() ?? Number.NEGATIVE_INFINITY) - (b.pairedAt?.getTime() ?? Number.NEGATIVE_INFINITY),
    )[0];
}

/** Rule 4: the lead owner's number when usable with room today, else the healthiest number; null = none (wait). */
export function chooseNumber(candidates: NumberCandidate[], leadOwnerId: string | null): string | null {
  const own = leadOwnerId ? healthiest(candidates.filter((n) => n.ownerUserId === leadOwnerId)) : undefined;
  return (own ?? healthiest(candidates))?.id ?? null;
}

/** How long a send waits when its number can't be used (never a switch to another number). */
export const NUMBER_WAIT_MS = 5 * 60_000;
export const NO_NUMBER_REASON = "No WhatsApp number is available (all are disconnected, paused or at today's cap).";

export type NumberPick = { numberId: string; assign: boolean } | { wait: string; retryAfterMs: number };

/**
 * Rules 3 + 5: a lead with a sticky number always uses it — paused, disconnected or removed
 * means the send waits; it never moves automatically. A lead without one gets one by rule 4
 * (`assign`: the caller stores it under the lead row lock), or waits when none is available.
 */
export function pickNumber(stickyId: string | null, candidates: NumberCandidate[], leadOwnerId: string | null): NumberPick {
  if (stickyId) {
    const sticky = candidates.find((n) => n.id === stickyId);
    if (!sticky || sticky.removed) return { wait: "This contact's WhatsApp number was removed.", retryAfterMs: NUMBER_WAIT_MS };
    if (sticky.paused) return { wait: `WhatsApp number ${sticky.label} is paused.`, retryAfterMs: NUMBER_WAIT_MS };
    if (!sticky.connected) return { wait: `WhatsApp number ${sticky.label} is not connected.`, retryAfterMs: NUMBER_WAIT_MS };
    return { numberId: stickyId, assign: false };
  }
  const chosen = chooseNumber(candidates, leadOwnerId);
  return chosen ? { numberId: chosen, assign: true } : { wait: NO_NUMBER_REASON, retryAfterMs: NUMBER_WAIT_MS };
}

/** Rule 7: the per-(number, phone) advisory-lock key (salt 0), shared by sends and inbound processing. */
export function numberPhoneLockKey(numberId: string, phoneE164: string): string {
  return `${numberId}:${phoneE164}`;
}

/** Rule 6: an admin moves a lead to another number, with a reason. Returns the problem, or null. */
export function moveProblem(currentId: string | null, target: NumberCandidate | undefined, reason: string): string | null {
  if (!reason.trim()) return "A reason is required.";
  if (!target || target.removed) return "That WhatsApp number doesn't exist in this workspace.";
  if (target.id === currentId) return "The contact already uses this WhatsApp number.";
  return null;
}
