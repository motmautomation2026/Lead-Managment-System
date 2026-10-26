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
9. **Routes are code-split (C3).** `vite.config.ts` runs the router plugin with `autoCodeSplitting: true`: each
   `routes/*.tsx` component becomes its own chunk, `__root` (shell + auth) stays in the entry. Keep route files thin
   (import the page from `features/`); never import a page component into the shell. `RoutePending`
   (`app/route-pending.tsx`) is the router's `defaultPendingComponent`. Budget: everything `index.html` loads up front
   < 350 kB gzip (C3: entry 101 kB, initial total 340 kB; was one 553 kB chunk).
10. **Picking a company = `CompanyPicker`** (`features/companies/company-picker.tsx`), never a `<Select>` of companies.

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
  inside a `Sheet` below `lg`. Contacts points to `/contacts` (C2).
- `top-bar.tsx` — breadcrumbs (`crumbsFor(pathname)` in `nav.ts`: add sub-pages to `SUB_PAGES`),
  search button, + Create (Contact, Company; enable Deal/Task/Meeting as their pages land), notifications,
  user menu (theme, density, sign out).
- `command-palette.tsx` — `GET /search` via `useGlobalSearch` (250 ms debounce, ≥ 2 chars) + actions
  (Create contact / company). Company results open `/companies/$companyId`; point deal results at the deal page in C4.
- App-wide create dialogs are hosted by the shell: `useAddLead().open({ company? })` (Create contact, optional
  prefilled company) and `useCreateCompanyDialog().open()` (`app/add-lead-context.ts`).
- Sidebar badge: admins see the open duplicate-company count on "Companies" (`useCompanyDuplicatesCount({}, isAdmin)`,
  cached 60 s).

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

## 6. Reference implementation: Contacts (C2)

Copy these when building Companies (C3) and Deals (C4). All in `Frontend/src/features/contacts/`.

**Index — `contacts-page.tsx` + `contacts-search.ts`** (route `routes/contacts.index.tsx`)
- `contactsSearchSchema` is both the route's `validateSearch` (via `validateContactsSearch`, which falls back to `{}`)
  and the `useListUrlState` schema. Filter keys are the API param names; date ranges are stored as whole IST days
  (`…T00:00:00+05:30` / `…T23:59:59+05:30`) and shown as `YYYY-MM-DD` in the FilterBar (`toFilterValues` /
  `fromFilterValues`).
- `toApiParams(state)` → `useContacts` (infinite) and `useContactsCount` (same params minus `sort`). `q` is only sent
  from 2 characters; the search box writes `q` with `replace: true` after 300 ms.
- Views = built-ins (`BUILT_IN_VIEWS`: All, My `ownerId=me`, Recently added `createdFrom = 7 days`, Unassigned
  `ownerId=none`) + `/saved-views`. Picking a view applies `{...NO_FILTERS, ...view.state(), view: id}` (it replaces
  the filters, sort and columns). `toSavedViewBody` / `savedViewState` convert between the URL and the stored view.
  Rename/delete only for `isMine` (or admins on shared views); shared views are labelled "· Shared".
- Columns: `DataTableColumn.id` = B4 column id; `sortable` only on whitelist fields; `DEFAULT_COLUMNS` when the URL
  has no `columns`. Row selection is keyed to the current params (it clears when filters change).
- Bulk actions call `useBulkContacts` (chunks of 100) and summarise per-id failures in one toast.

**Record — `contact-record-page.tsx`** (route `routes/contacts.$contactId.tsx`)
- Fetch the record by id (`useContact`) — never from a list cache. 404 → EmptyState with a link back.
- `PageHeader heading={identity}` + quick actions (secondary buttons + "More" `DropdownMenu modal={false}`) →
  optional DNC banner (`bg-danger-soft`) → `RecordLayout` (`left` = About, five tabs, `right` = associations,
  `rightLabel="Associations"`).
- About (`contact-about.tsx`): `PropertyList` items with `editor(done)`; text editors are tiny react-hook-form forms
  that validate with the same rules as create and show backend errors inline; selects save on change.
- Associations (`contact-associations.tsx`): `AssociationCard`s; create dialogs on react-hook-form + Zod.
- Activity: the shared paginated `ActivityFeed contactId` (C3; `features/crm/activity-feed.tsx`), chips filter server-side.
- Every write invalidates through `refreshContact(client, ws, id)` (`store/query.ts`).

## 7. Companies (C3) — `Frontend/src/features/companies/`

Same patterns as Contacts; copy these for Deals (C4).

**Index — `companies-page.tsx` + `companies-search.ts`** (route `routes/companies.index.tsx`)
- `companiesSearchSchema` (view, q, sort, columns, `ownerId[]`, `industry[]`, `hasDomain`, `createdFrom/To`) = route
  `validateSearch` + `useListUrlState` schema. Views: All / My (`ownerId=me`) / Recently added + saved views (object
  `companies`). Industry options from `GET /companies/industries`. Default sort `name:asc`; sortable `name`,
  `contactCount`, `createdAt`, `updatedAt`. "Open deals" shows count + INR total (`openDealCount` column).
- Admins get "Review duplicates (N open)" (`GET /company-duplicates/count`).

**Create — `create-company-dialog.tsx`**: react-hook-form + `companyFormSchema` (`company-helpers.ts`, shared with
About). A 409 (`existingCompanyId(error)`) shows "This company already exists" + a link to it; field 400s inline.

**Record — `company-record-page.tsx`** (route `routes/companies.$companyId.tsx`)
- Fetched by id (`useCompany`); 404 → EmptyState; `mergedIntoCompanyId` → "Merged into X" with a link.
- Header actions: Add contact (`useAddLead().open({ company: name })`), Create deal (pick one of its contacts →
  the C2 `CreateDealDialog`), More → Merge (admins, `merge-company-dialog.tsx`: CompanyPicker, side by side, choose
  which stays, then open the survivor).
- About (`company-about.tsx`): PropertyList, text editors validate with `companyFormSchema.shape[field]`, `""` clears
  (null); renaming a company with contacts confirms "This also updates the company name on N contacts."
- Tabs: Overview (facts, `ActivityFeed limit={5}`, open deals), Activity (`ActivityFeed companyId`), Contacts
  (`CONTACT_COLUMNS` from `features/contacts/contact-columns.tsx`, local sort state), Deals (`status=all`). Right:
  Contacts / Open deals / Possible duplicates (admins, `useCompanyDuplicates({ companyId })`).

**Activity feeds — `features/crm/activity-feed.tsx`**: `<ActivityFeed contactId|companyId [limit] />` over the
paginated timelines; chips (`ACTIVITY_FILTERS`) send `kind` to the server, "Load more" pages; company rows link the
contact. Never filter or sort timelines in React.

**CompanyPicker**: `value: {id,name} | null`, `onChange`, `variant` `"field"` (forms) | `"chip"` (list filters, with
a clear button), `allowCreate` ("Create company '<text>'"; a 409 picks the existing company), `excludeIds`.
Debounced `GET /companies?q=` (≥ 2 chars, top 5), cmdk keyboard. Used by the Contacts Company filter, Change company
on a contact, merge, and duplicate relink.

**Duplicate review — `duplicates-page.tsx` + `duplicates-search.ts`** (route `routes/companies.duplicates.tsx`, admins;
others see "Admins only"): kind tabs with counts, Reason / Status filters in the URL, server-paginated rows. Pair rows:
Merge… (choose which stays, confirm) / Not a duplicate (confirm). Contact rows: Keep link (dismiss) / Move to another
company (CompanyPicker → relink) / Create separate company (relink without `companyId`). Rows leave the list
optimistically and come back with the error if the request fails.

**Data layer**: hooks in `store/server-hooks.ts` (`useCompanies`, `useCompaniesCount`, `useCompanyIndustries`,
`useCompanyContacts`, `useCompanyDeals`, `useCompanyTimeline`, `useContactTimeline`, `useCreateCompany`,
`useUpdateCompany`, `useMergeCompanies`, `useCompanyDuplicates`, `useCompanyDuplicatesCount`, `useMergeDuplicate`,
`useDismissDuplicate`, `useRelinkDuplicate`; keyset lists through `useCursorList`). Every company write calls
`refreshCompany(client, ws)` (company views, duplicates, company + global search, and `refreshContact(client, ws)`);
`refreshContact` also refreshes the company views and the paginated contact timeline.
