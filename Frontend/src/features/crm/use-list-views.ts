import { useIsAdmin, useSavedViews } from "@/store";
import type { SavedView } from "@/types";
import {
  canEditView,
  matchesView,
  savedViewState,
  type ListViewSpec,
  type ListViewState,
} from "./saved-views";

export interface ListView<S> {
  id: string;
  label: string;
  state: () => Partial<S>;
  saved?: SavedView;
}

/**
 * Views of one index page: built-ins + /saved-views, the selected one (`view=` in the URL),
 * whether the URL has drifted from it ("Edited") and `apply` (replaces filters, sort, columns).
 * `onApply` lets the page sync local inputs (the search box) with the applied state.
 */
export function useListViews<S extends ListViewState>(
  spec: ListViewSpec<S>,
  state: S,
  set: (patch: Partial<S>) => unknown,
  onApply?: (next: Partial<S>) => void,
) {
  const isAdmin = useIsAdmin();
  const savedQuery = useSavedViews(spec.object);
  const saved = savedQuery.data?.data ?? [];
  const views: ListView<S>[] = [
    ...spec.builtIns,
    ...saved.map((v) => ({
      id: v.id,
      label: v.isShared ? `${v.name} · Shared` : v.name,
      state: () => savedViewState<S>(v, spec.multiKeys),
      saved: v,
    })),
  ];
  const activeId = state.view ?? "all";
  const active = views.find((v) => v.id === activeId);
  const edited = active ? !matchesView(spec, state, active.state()) : false;

  const apply = (id: string) => {
    const view = views.find((v) => v.id === id) ?? spec.builtIns[0]!;
    const next = view.state();
    onApply?.(next);
    void set({ ...spec.noFilters, ...next, view: view.id === "all" ? undefined : view.id });
  };

  return {
    spec,
    state,
    set,
    views,
    saved,
    activeId,
    active,
    edited,
    canEditActive: Boolean(active?.saved && canEditView(active.saved, isAdmin)),
    isAdmin,
    apply,
  };
}

export type ListViewsController<S extends ListViewState> = ReturnType<typeof useListViews<S>>;
