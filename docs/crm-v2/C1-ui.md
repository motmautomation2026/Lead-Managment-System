# CRM v2 — UI kit and app shell (C1)

What every new page (C2–C6) builds on. Design: `B2-design.md` §5. API: `B4-api.md`.
Live examples: `/dev/ui` (dev builds only), light and dark side by side.

## 1. Rules for C2–C6

1. **Use these components.** Index pages = `PageHeader` + `ViewTabs` + `FilterBar` + `DataTable`;
   record pages = `PageHeader` (with `heading`) + `RecordLayout` + `PropertyList` + `AssociationCard`.
   Don't hand-write tables, empty states or pills.
2. **No hard-coded colours.** Only theme tokens (`bg-card`, `text-muted-foreground`, `bg-success-soft`…).
   No `bg-white`, `text-gray-*`, `#hex`. Exceptions (on purpose): the WhatsApp QR (`bg-white`, must
   scan) and the email preview iframe (`bg-white`, emails render on white).
3. **Lists are always server-side via B4.** `useInfiniteQuery` over the list endpoint (`{data, nextCursor}`),
   totals from `/count`. Never fetch "everything" and filter in React.
4. **The URL holds list state.** Filters, sort, view and `q` live in the search params through
   `useListUrlState(schema)` with the same Zod schema as the route's `validateSearch`. Filter values use
   the list endpoint's param names (`ownerId`, `leadStatus`, `hasOpenDeal`…) so saved views
   (`/saved-views` `filters`) and URLs are interchangeable.
5. Sorting is single-column and only on whitelisted B4 sort fields: `DataTableColumn.id` = the API
   sort field / B4 column id.
6. Every icon-only button has an `aria-label`. Every page has loading, empty and error states and
   works at 375 px.
7. New forms use `react-hook-form` + `@hookform/resolvers/zod`.
8. Type scale: `type-page-title`, `type-section-title`, `type-body`, `type-small`, `type-label`.

## 2. Tokens (`Frontend/src/styles.css`)

Shadcn set (light in `:root, .light`, dark in `.dark`): `background`, `foreground`, `card`, `popover`,
`primary` (#bc422c light / #f58a59 dark), `secondary`, `muted`, `accent`, `destructive`, `border`,
`input`, `ring`, `chart-1..5`, `sidebar-*`, `surface`.

Added in C1:

| Token | Use |
|---|---|
| `success` / `warning` / `info` / `danger` (+ `-foreground`) | solid fills (`danger` = `destructive`) |
| `*-soft` + `*-soft-foreground` | pills, notices, and coloured text on page backgrounds |
| `surface-raised` | panels above cards |
| `focus-ring` | global `:focus-visible` outline (utilities like `outline-none` + `ring` still win) |
| `--row-height`, `--cell-px`, `--cell-py` | table density; `<html data-density="compact">` tightens them |

All text/background pairs are checked ≥ 4.5:1 in both themes by `src/styles-contrast.test.ts`
(`PRINT_CONTRAST=1 npx vitest run src/styles-contrast.test.ts --silent=false --reporter=verbose`
prints the ratios). Add new pairs there.

Theme + density: `ThemeProvider` (`app/theme-provider.tsx`, hook `useTheme` in `app/theme-context.ts`),
localStorage `motmflow.theme` (light/dark/system, default system) and `motmflow.density`
(comfortable/compact); `index.html` applies both before first paint. Sidebar collapse:
`motmflow.sidebarCollapsed`. Keys live in `lib/preferences.ts`.

## 3. App shell (`Frontend/src/app/`)

- `app-shell.tsx` — layout, Add lead context, Create workspace dialog, ⌘K.
- `sidebar.tsx` — groups from `nav.ts` (`NAV_GROUPS`, `SETTINGS_NAV`, `ADMIN_NAV`); collapsible;
  inside a `Sheet` below `lg`. Contacts still points to `/leads` (moves in C2).
- `top-bar.tsx` — breadcrumbs (`crumbsFor(pathname)` in `nav.ts`: add sub-pages to `SUB_PAGES`),
  search button, + Create (enable Company/Deal/Task/Meeting as their pages land), notifications,
  user menu (theme, density, sign out).
- `command-palette.tsx` — `GET /search` via `useGlobalSearch` (250 ms debounce, ≥ 2 chars) + actions.
  When company/deal record pages exist, point their results at them.

## 4. Components (`Frontend/src/components/crm/`)

| Component | Props (main) |
|---|---|
| `PageHeader` | `title`, `count?`, `description?`, `actions?` (secondary), `primaryAction?`, `tabs?`, `heading?` (replaces the title block) |
| `ViewTabs` | `views: {id,label}[]`, `activeId`, `onChange(id)`, `onSaveView?` (shows "+"), `maxVisible=5` (rest in "More") |
| `FilterBar` | `filters: FilterDef[]` (chips), `moreFilters?` (Sheet), `values: FilterValues`, `onChange(values)`. `FilterDef.type`: `multi` (`options`), `dateRange` (`{from,to}` YYYY-MM-DD), `numberRange` (`{min,max}`), `boolean`. Helpers in `filter-model.ts` |
| `DataTable<T>` | `label`, `data`, `columns: {id, header, cell(row), sortable?, size?, hideable?}[]`, `getRowId`, `getRowHref?`, `onRowClick?`, `sort?`/`onSortChange?` (`{field, dir}`), `visibleColumns?`/`onColumnsChange?` (picker), `enableResizing?`, `selectedIds?`/`onSelectionChange?`/`bulkActions?`, `hasNextPage?`/`isFetchingNextPage?`/`onLoadMore?`, `isLoading?`, `error?`/`onRetry?`, `emptyState?`, `className?` (scroll box height; default `max-h-[calc(100dvh-14rem)]`) |
| `BulkActionBar` | `count`, `actions?`, `onClear` (DataTable renders it when `bulkActions` is set) |
| `RecordLayout` | `left`, `tabs: {id,label,content}[]`, `right?`, `defaultTab?` (below lg: About · tabs · Related) |
| `PropertyList` | `items: {id, label, value, editor?(done)}[]` |
| `AssociationCard` | `title`, `count?`, `items: {id,title,subtitle?,meta?}[]`, `onAdd?`, `addLabel?`, `emptyText?` |
| `EmptyState` | `icon?`, `title`, `text?`, `action?` |
| `StatusPill` | `tone` (neutral/primary/info/success/warning/danger), `dot?` |
| `UserAvatar` | `name` (null → "–"), `size` sm/md |
| `Money` | `amount`, `currency="INR"`, `compact?` (lakh/crore); `formatMoney` in `lib/format.ts` |
| `RelativeTime` | `value` ISO (IST "Today, 3:10 pm" / "12 Oct 2026 (4d ago)") |

Hooks: `useListUrlState(schema)` → `[state, set(patch, {replace?})]` (`lib/use-list-url-state.ts`;
pushes history, drops empty values); `useMediaQuery`, `useDebouncedValue` (`lib/`).
UI primitives added: `ui/sheet`, `ui/dropdown-menu`, `ui/tooltip`, `ui/skeleton`.

DataTable behaviour: the table scrolls inside its own box (sticky header, virtualisation above 200
rows, infinite-scroll sentinel all use it); the first column renders a real `<a href>` so
ctrl/⌘/middle-click opens a new tab; keyboard ↑/↓ move, Enter opens, Space selects.
Don't open a Dialog from a *modal* DropdownMenu item (focus traps fight): use `modal={false}`
on that menu, as the + Create menu does.

## 5. Page patterns

**Index page** (C2 Contacts as the template):

```tsx
const search = listSearchSchema; // route validateSearch, same Zod as the API filters
const [state, set] = useListUrlState(search);
const list = useInfiniteQuery({ queryKey: keys.contacts(ws, state), ... });
<PageHeader title="Contacts" count={count} primaryAction={<Button>Create contact</Button>}
  tabs={<ViewTabs views={views} activeId={state.view} onChange={(view) => set({ view })} onSaveView={save} />} />
<FilterBar filters={quick} moreFilters={more} values={toFilterValues(state)} onChange={(v) => set(fromFilterValues(v))} />
<DataTable label="Contacts" data={rows} columns={columns} sort={parseSort(state.sort)}
  onSortChange={(s) => set({ sort: `${s.field}:${s.dir}` })} hasNextPage={list.hasNextPage}
  onLoadMore={list.fetchNextPage} getRowHref={(r) => `/contacts/${r.id}`} onRowClick={open} ... />
```

**Record page**: `PageHeader heading={identity + quick actions}` → `RecordLayout left={<PropertyList/>}
tabs={[Overview, Activity, Notes, Meetings & proposals, Automation]} right={<AssociationCard/>…}`.
