import { useCallback, useMemo } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
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
