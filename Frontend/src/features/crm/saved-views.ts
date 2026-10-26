import type { SavedView, SavedViewObject } from "@/types";

/** The URL state every index page shares (plus its own filter keys). */
export interface ListViewState {
  view?: string | undefined;
  q?: string | undefined;
  sort?: string | undefined;
  columns?: string[] | undefined;
}

export interface BuiltInView<S> {
  id: string;
  label: string;
  /** URL patch applied after `noFilters`. */
  state: () => Partial<S>;
}

/** What an index page tells the shared saved-views code about its list (one per object). */
export interface ListViewSpec<S extends ListViewState> {
  object: SavedViewObject;
  builtIns: BuiltInView<S>[];
  /** Every filter key (+ sort, columns) set to undefined: spread first to replace, not merge. */
  noFilters: Partial<S>;
  /** Params that are arrays in the URL (a stored view may hold one string). */
  multiKeys: readonly string[];
  /** The list endpoint's params for this state; `sort` always set (the default when absent). */
  toApiParams: (state: S) => object;
  defaultColumns: string[];
  /**
   * C6a: a bare URL (no params at all) opens this built-in view, written to the URL with
   * `view=` (replace). Without it a bare URL = the "all" view. With it, no built-in may use the
   * id "all" (applying it would clear the URL and land on the default again).
   */
  defaultView?: string;
}

export interface SavedViewBody {
  filters: Record<string, string | string[]>;
  sort: string | null;
  columns: string[] | null;
}

/** A saved view's stored params → URL state. */
export function savedViewState<S extends ListViewState>(
  view: SavedView,
  multiKeys: readonly string[],
): Partial<S> {
  const state: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(view.filters)) {
    state[key] = multiKeys.includes(key) && !Array.isArray(value) ? [value] : value;
  }
  return {
    ...(state as Partial<S>),
    sort: view.sort ?? undefined,
    columns: view.columns ?? undefined,
  };
}

/** The current list as a saved view body (filters exactly as the API params). */
export function toSavedViewBody<S extends ListViewState>(
  state: S,
  toApiParams: (state: S) => object,
): SavedViewBody {
  const { sort: _sort, ...filters } = toApiParams(state) as Record<string, unknown>;
  return {
    filters: Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v !== undefined),
    ) as Record<string, string | string[]>,
    sort: state.sort ?? null,
    columns: state.columns ?? null,
  };
}

/**
 * True when the URL shows the same list as the view: same filters (multi values in any
 * order), sort and columns, with absent sort/columns meaning the defaults.
 */
export function matchesView<S extends ListViewState>(
  spec: ListViewSpec<S>,
  current: S,
  view: Partial<S>,
): boolean {
  const viewState = { ...spec.noFilters, ...view } as S;
  const norm = (state: S) => {
    const { filters } = toSavedViewBody(state, spec.toApiParams);
    const sortedFilters = Object.fromEntries(
      Object.keys(filters)
        .sort()
        .map((k) => {
          const v = filters[k]!;
          return [k, Array.isArray(v) ? [...v].sort() : v];
        }),
    );
    return JSON.stringify([
      sortedFilters,
      (spec.toApiParams(state) as { sort?: string }).sort ?? null,
      state.columns ?? spec.defaultColumns,
    ]);
  };
  return norm(current) === norm(viewState);
}

/** The API's rule: owners manage their views; admins also shared ones. */
export const canEditView = (view: SavedView, isAdmin: boolean) =>
  view.isMine || (isAdmin && view.isShared);
