import { useCallback, type PointerEvent } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { backend } from "@/lib/backend-client";
import { keys } from "@/store/query";
import { useWorkspace } from "@/store/workspace-context";

export type RecordType = "contact" | "company" | "deal";

/** How long a prefetched record counts as fresh, so opening it right after hovering doesn't refetch. */
export const PREFETCH_STALE_MS = 30_000;

export const RECORD_ROUTES = {
  contact: (id: string) => ({ to: "/contacts/$contactId", params: { contactId: id } }) as const,
  company: (id: string) => ({ to: "/companies/$companyId", params: { companyId: id } }) as const,
  deal: (id: string) => ({ to: "/deals/$dealId", params: { dealId: id } }) as const,
};

/**
 * Preloads a record page on intent: its route chunk plus the same query (key + fetch) the
 * record page uses, so the page renders exactly what it would have fetched itself.
 */
export function usePrefetchRecord() {
  const router = useRouter();
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCallback(
    (type: RecordType, id: string) => {
      if (!ws || !id) return;
      router.preloadRoute(RECORD_ROUTES[type](id)).catch(() => undefined);
      // The client the root route provides (router context), as route loaders would use it.
      const client = (router.options.context as { queryClient?: QueryClient } | undefined)
        ?.queryClient;
      if (!client) return;
      const query =
        type === "contact"
          ? { queryKey: keys.contact(ws, id), queryFn: () => backend.contacts.get(id) }
          : type === "company"
            ? { queryKey: keys.company(ws, id), queryFn: () => backend.companies.get(id) }
            : { queryKey: keys.deal(ws, id), queryFn: () => backend.deals.get(id) };
      void client.prefetchQuery({ ...query, staleTime: PREFETCH_STALE_MS } as Parameters<
        typeof client.prefetchQuery
      >[0]);
    },
    [router, ws],
  );
}

/** Hover (mouse/pen only: touch "hovers" fire while scrolling) and keyboard focus. */
export function intentHandlers(run: () => void) {
  return {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType !== "touch") run();
    },
    onFocus: run,
  };
}
