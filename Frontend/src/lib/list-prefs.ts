import { useCallback, useState } from "react";
import { useSession } from "@/store";

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
const DEFAULT_PAGE_SIZE: PageSize = 50;

interface Stored {
  pageSize?: number;
  columns?: string[];
}

const keyFor = (userId: string, listId: string) => `motmflow.list.${userId}.${listId}`;

function read(key: string): Stored {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "{}") as unknown;
    return value && typeof value === "object" ? (value as Stored) : {};
  } catch {
    return {};
  }
}

function write(key: string, patch: Stored) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ ...read(key), ...patch }));
  } catch {
    // Storage unavailable: the choice still applies until the page reloads.
  }
}

/**
 * UX-2 list standard: page size and visible columns remembered per user and list in this
 * browser. URL columns (a shared link or a saved view) win over the remembered ones.
 */
export function useListPrefs(listId: string, urlColumns: string[] | undefined, defaults: string[]) {
  const userId = useSession().currentUser?.id ?? "anon";
  const key = keyFor(userId, listId);
  const [stored, setStored] = useState<{ key: string; value: Stored }>(() => ({
    key,
    value: read(key),
  }));
  // The user loads after the first render: re-read once the key changes.
  const value = stored.key === key ? stored.value : read(key);
  if (stored.key !== key) setStored({ key, value });

  const pageSize = PAGE_SIZES.includes(value.pageSize as PageSize)
    ? (value.pageSize as PageSize)
    : DEFAULT_PAGE_SIZE;
  const remember = useCallback(
    (patch: Stored) => {
      write(key, patch);
      setStored((s) => ({ key, value: { ...s.value, ...patch } }));
    },
    [key],
  );
  return {
    pageSize,
    /** The list request's `limit`: omitted at the API default (50). */
    limit: pageSize === DEFAULT_PAGE_SIZE ? undefined : pageSize,
    setPageSize: (size: PageSize) => remember({ pageSize: size }),
    columns: urlColumns ?? value.columns ?? defaults,
    rememberColumns: (columns: string[]) => remember({ columns }),
  };
}
