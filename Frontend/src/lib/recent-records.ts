/**
 * The last records this viewer opened, per workspace, for the ⌘K palette. A per-browser
 * convenience only: ids + label + type (no other data), storage may be missing or throw,
 * and anything unreadable is treated as "no recents".
 */
export type RecentType = "contact" | "company" | "deal";
export interface RecentRecord {
  type: RecentType;
  id: string;
  label: string;
}

export const MAX_RECENTS = 8;
const TYPES: readonly string[] = ["contact", "company", "deal"];
const storageKey = (workspaceId: string) => `motmflow.recent.${workspaceId}`;

export function readRecents(workspaceId: string | null): RecentRecord[] {
  if (!workspaceId) return [];
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(storageKey(workspaceId)) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is RecentRecord =>
          typeof r === "object" &&
          r !== null &&
          TYPES.includes((r as RecentRecord).type) &&
          typeof (r as RecentRecord).id === "string" &&
          typeof (r as RecentRecord).label === "string",
      )
      .map(({ type, id, label }) => ({ type, id, label }))
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/** Moves the record to the front (newest first), keeping at most MAX_RECENTS. */
export function rememberRecent(workspaceId: string | null, record: RecentRecord) {
  if (!workspaceId || !record.id) return;
  const rest = readRecents(workspaceId).filter(
    (r) => !(r.type === record.type && r.id === record.id),
  );
  try {
    window.localStorage.setItem(
      storageKey(workspaceId),
      JSON.stringify(
        [{ type: record.type, id: record.id, label: record.label }, ...rest].slice(0, MAX_RECENTS),
      ),
    );
  } catch {
    // Storage unavailable: no recents this session.
  }
}
