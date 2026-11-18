import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import type { z } from "zod";

/** Drops empty values so shared URLs stay short ("", [], undefined, null). */
function compact(search: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(search).filter(
      ([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0),
    ),
  );
}

/**
 * List state (filters, sort, view, q) kept in the URL search params, so links
 * are shareable and Back works. Pass the same Zod schema the route uses as
 * `validateSearch`; it must accept `{}` (use defaults/optionals).
 * `set(patch)` pushes a history entry; `{ replace: true }` for typing in a search box.
 */
export function useListUrlState<S extends z.ZodTypeAny>(schema: S) {
  const raw = useSearch({ strict: false });
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // UX-3: record breadcrumbs return to the list with these filters.
  useEffect(() => rememberListSearch(pathname, raw), [pathname, raw]);
  const state = useMemo(() => {
    const parsed = schema.safeParse(raw);
    return (parsed.success ? parsed.data : schema.parse({})) as z.infer<S>;
  }, [raw, schema]);

  const set = useCallback(
    (patch: Partial<z.infer<S>>, options?: { replace?: boolean }) =>
      navigate({
        to: ".",
        search: ((prev: Record<string, unknown>) => compact({ ...prev, ...patch })) as never,
        replace: options?.replace ?? false,
      }),
    [navigate],
  );

  return [state, set] as const;
}

const listKey = (pathname: string) => `motmflow.list.${pathname}`;

/** The list's last search params for this tab (sessionStorage; unreadable storage = none). */
export function rememberListSearch(pathname: string, search: Record<string, unknown>) {
  try {
    window.sessionStorage.setItem(listKey(pathname), JSON.stringify(search));
  } catch {
    // Storage unavailable: the breadcrumb opens the plain list.
  }
}

export function lastListSearch(pathname: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(listKey(pathname)) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
