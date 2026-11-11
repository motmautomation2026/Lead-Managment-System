import { useNavigate, useRouterState } from "@tanstack/react-router";

/**
 * One string search param of the current route (`?tab=`, `?number=`), read and written in place
 * (history `replace`, other params kept). `undefined` removes it.
 */
export function useSearchParam(name: string) {
  const value = useRouterState({
    select: (s) => (s.location.search as Record<string, unknown>)[name],
  });
  const navigate = useNavigate();
  const set = (next: string | undefined, options: { replace?: boolean } = {}) =>
    void navigate({
      search: ((prev: Record<string, unknown>) => ({ ...prev, [name]: next })) as never,
      replace: options.replace ?? true,
    });
  return [typeof value === "string" ? value : undefined, set] as const;
}

/** `?tab=` of a section with tabs: unknown / missing = the first tab, which is written as no param. */
export function useSearchTab<T extends string>(tabs: readonly T[]) {
  const [raw, set] = useSearchParam("tab");
  const value = ((tabs as readonly string[]).includes(raw ?? "") ? raw : tabs[0]) as T;
  return [value, (next: T) => set(next === tabs[0] ? undefined : next)] as const;
}
