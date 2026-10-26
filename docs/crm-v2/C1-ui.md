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
   **≤ 350 kB gzip**, enforced by `npm run size` (`scripts/check-bundle-size.mjs`, the last step of `npm run check`;
   `npm run size -- --list` prints each file). C3: 340 kB; C4: 345 kB; **C5: 286 kB** (the palette and the three create
   dialogs are `React.lazy` in `app-shell.tsx`, mounted on first open, so cmdk, react-hook-form, libphonenumber-js and
   Radix Select are not loaded up front). Keep shell-hosted dialogs lazy; run `npm run size -- --list` after adding a
   dependency to anything the shell imports.
13. **Record links prefetch on intent (C5).** Links to a contact/company/deal record use `RecordLink`
    (`features/crm/record-link.tsx`); tables pass `onRowIntent={(r) => prefetch(type, r.id)}` from `usePrefetchRecord()`
    (`features/crm/prefetch.ts`). Mouse/pen hover or keyboard focus (never touch, which fires while scrolling) preloads the
    route chunk and the record page's own query (same key + fetch, 30 s stale) through the root's QueryClient (router
    context). It never changes what the record page shows.
14. **Index-page search boxes carry `data-list-search`** so the `/` shortcut can focus them.
10. **Picking a company = `CompanyPicker`** (`features/companies/company-picker.tsx`), never a `<Select>` of companies.
11. **Picking a contact = `ContactPicker`** (`features/contacts/contact-picker.tsx`, C4), never a `<Select>` of contacts.
15. **IST and business rules come from the backend (C6a).** "Today", "overdue", "upcoming", "needs outcome" and
    proposal groups are list params the backend computes in SQL (IST days); rows carry what the UI shows
    (`isOverdue`, `allowedNextStatuses`). The UI only collects IST date + time (`toIsoFromIst`, `istParts`,
    `defaultCallbackSlot` in `lib/dates.ts`) and shows backend errors; it never decides which moves are allowed.
16. **List rows open a Sheet (C6a).** Rows without a record page (tasks, meetings, proposals) open a right-hand
    `Sheet` (`PropertyList` details + actions); links inside rows use `RefLink` (`features/work/ref-link.tsx`, stops the
    row click). Dialogs the Sheet starts live on the page, so the Sheet closes first.
12. **Deal stage rules live in the backend.** The UI shows stages (`DEAL_STAGE_LABELS`, display only) and calls
    `POST /deals/:id/stage`; Won/Lost always go through `CloseDealDialog`; errors are shown, never pre-empted.

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
  search button, + Create (Contact, Company, Deal (C4), Task, Meeting (C6a)), notifications,
  user menu (theme, density, sign out).
- `command-palette.tsx` (lazy, C5) — `GET /search` via `useGlobalSearch` (250 ms debounce, ≥ 2 chars) + actions.
  Empty query: **Recent** (the last 8 records opened; `lib/recent-records.ts`, localStorage `motmflow.recent.<workspaceId>`,
  type + id + label only, unreadable storage = none; record pages call `useRememberRecent`), then quick actions (Create
  contact/company/deal, Go to Contacts/Companies/Deals/Tasks). With a query: grouped results (5 each), matching actions,
  and a last row **See all results for "q"** → `/search?q=` (shown once results arrive, so the first result stays
  highlighted).
- `/search?q=&tab=` (`features/search/`, C5): search box (300 ms, replace), tabs Contacts · Companies · Deals with counts
  from each `/count`, each a DataTable on its list endpoint with `q` (contacts `lifecycle=all`, deals `status=all`: the
  same scope as `GET /search`), Load more, "Open in … list" carries the params. No endpoint of its own.
- `shortcuts.ts` (C5) — the one registry: `SHORTCUTS` (⌘K/Ctrl+K palette, `?` help, `/` list search, `n` Create menu,
  `g` then `c`/`o`/`d`/`t`/`m`/`p` within 1 s — Meetings and Proposals since C6a), `createShortcutMatcher` (pure; ignores keys typed in inputs/textareas/
  contenteditable, with any `[role=dialog|alertdialog|menu|listbox]` open, during a dnd-kit keyboard drag, and with
  Ctrl/Alt/Meta except ⌘K) and `useShortcuts(handlers)` (in the shell). `shortcuts-dialog.tsx` lists the registry (`?` or
  user menu → Keyboard shortcuts). A new shortcut = one `SHORTCUTS` entry + its handler in `app-shell.tsx`.
- App-wide create dialogs are hosted by the shell: `useAddLead().open({ company? })` (Create contact, optional
  prefilled company), `useCreateCompanyDialog().open()` and `useCreateDealDialog().open({ contact?, companyId?, stay? })`
  (C4; `app/add-lead-context.ts`), `useCreateTaskDialog().open({ contact? })` and
  `useScheduleMeetingDialog().open({ leadId?, dealId? })` (C6a). The shell remounts each per opening (`key`, distinct
  per dialog) so each starts fresh; all are `React.lazy`, mounted on first open.
- Sidebar badge: admins see the open duplicate-company count on "Companies" (`useCompanyDuplicatesCount({}, isAdmin)`,
  cached 60 s). Everyone sees **my overdue tasks** on "Tasks" (`useTaskCount({ ownerId: ["me"], due: "overdue" })`, the
  same key as the Tasks page's Overdue tab, refreshed by `refreshWork`).

## 4. Components (`Frontend/src/components/crm/`)

| Component | Props (main) |
|---|---|
| `PageHeader` | `title`, `count?`, `description?`, `actions?` (secondary), `primaryAction?`, `tabs?`, `heading?` (replaces the title block) |
| `ViewTabs` | `views: {id,label,edited?,count?}[]` (`count` = small badge, C6a), `activeId`, `onChange(id)`, `onSaveView?` (shows "+"), `maxVisible=5` (rest in "More") |
| `FilterBar` | `filters: FilterDef[]` (chips), `moreFilters?` (Sheet), `values: FilterValues`, `onChange(values)`. `FilterDef.type`: `multi` (`options`), `dateRange` (`{from,to}` YYYY-MM-DD), `numberRange` (`{min,max}`), `boolean`. Helpers in `filter-model.ts` |
| `DataTable<T>` | `label`, `data`, `columns: {id, header, cell(row), sortable?, size?, hideable?}[]`, `getRowId`, `getRowHref?`, `onRowClick?`, `sort?`/`onSortChange?` (`{field, dir}`), `visibleColumns?`/`onColumnsChange?` (picker), `enableResizing?`, `selectedIds?`/`onSelectionChange?`/`bulkActions?`, `hasNextPage?`/`isFetchingNextPage?`/`onLoadMore?`, `isLoading?`, `error?`/`onRetry?`, `emptyState?`, `className?` (scroll box height; default `max-h-[calc(100dvh-14rem)]`) |
| `BulkActionBar` | `count`, `actions?`, `onClear` (DataTable renders it when `bulkActions` is set) |
| `RecordLayout` | `left`, `tabs: {id,label,content}[]`, `right?`, `defaultTab?` (below lg: About · tabs · Related) |
| `PropertyList` | `items: {id, label, value, editor?(done)}[]` |
| `AssociationCard` | `title`, `count?`, `items: {id,title,subtitle?,meta?}[]`, `onAdd?`, `addLabel?`, `emptyText?`, `footer?` (C6a: "View all" link) |
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
Don't open a Dialog from a *modal* DropdownMenu item (focus traps fight; in tests it hangs the worker): use
`modal={false}` on that menu, as the + Create menu, the user menu and View options do.

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

## 5a. Saved views (C5) — `features/crm/`

One implementation for Contacts, Companies and Deals:
- Each `*-search.ts` exports a `ListViewSpec` (`CONTACT_VIEW_SPEC`, `COMPANY_VIEW_SPEC`, `DEAL_VIEW_SPEC`: object,
  built-ins, `NO_FILTERS`, multi keys, `toApiParams`, default columns). `saved-views.ts`: `savedViewState`,
  `toSavedViewBody`, `matchesView` (multi values in any order; absent sort/columns = the defaults), `canEditView` (own
  views; admins also shared ones).
- Page: `const views = useListViews(SPEC, state, set, onApply)` → `<PageHeader tabs={<SavedViewTabs controller={views} />} />`;
  `views.apply(id)` replaces filters, sort and columns (`view=` stays in the URL, so reload and Back work).
- **Edited**: when the URL differs from the selected view, the tab shows "Edited" plus Save (PATCH; only if you may edit
  it), Save as new and Reset (saved views only; built-ins offer only Save as new). "+" also saves as new.
- **Save dialog** (`save-view-dialog.tsx`): react-hook-form + Zod name, "Share with the team"; new views get
  `position = max + 1`; API errors (409, the 30-view limit) inline.
- **Manage views** (View options → Manage views…, `manage-views-dialog.tsx`): inline rename, `@dnd-kit/sortable` reorder
  (pointer + keyboard) → PATCH `position` for the views that moved, Share switch on own views, delete with confirm.
  Controls follow the API's rights; others' views are listed without controls; errors inline. `position` is one order
  for the workspace, so a salesperson moves only their own views (others keep theirs).

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
  `ownerId=none`) + `/saved-views`, through the shared saved-views code (§5a); shared views are labelled "· Shared".
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

## 8. Deals (C4) — `Frontend/src/features/deals/`

Same patterns as Contacts/Companies. Display labels and tones in `deal-labels.ts` (`DEAL_STAGE_LABELS`, design §1.4
board names; `OPEN_DEAL_STAGES`; `CONTACT_ACTION_OPTIONS`); a stage renders as `<DealStagePill stage>` everywhere.

**Index — `deals-page.tsx` + `deals-search.ts`** (route `routes/deals.index.tsx`)
- `dealsSearchSchema` = route `validateSearch` + `useListUrlState` schema: view, q, sort, columns, `stage[]`, `ownerId[]`,
  `status`, `companyId`, `amountMin/Max`, `expectedCloseFrom/To` (YYYY-MM-DD), `createdFrom/To`, plus page-only `layout`
  (`board`; absent = table) and `showClosed` (`true`). Saved views (object `deals`) store only the API filters.
- Views: All open deals · My deals · Closing this month (`currentIstMonth()`: first–last day of the IST month) · Won ·
  Lost + saved views (five built-ins fill the tabs; saved ones go under "More").
- Filters: Stage, Owner, Status (single value: the last picked wins), Amount (numberRange), Expected close; More:
  Created; Company = `CompanyPicker variant="chip"`. Columns = `DEAL_COLUMNS` (`deal-columns.tsx`), default sort
  `updatedAt:desc`; sortable `name, amount, expectedCloseDate, createdAt, updatedAt`.
- Layout switch Table | Board (`layout` in the URL). The board shares the filters but drops `stage`/`sort` and takes
  `status` from Show closed (`toBoardParams`); the header count follows the visible layout's params.

**Board — `deal-board.tsx`**: `useDealBoard` (one `GET /deals/board`); columns with count + INR total (Money compact),
cards (name link, company · contact, amount, expected close, owner avatar). "Load more" per column calls
`GET /deals?stage=…&sort=updatedAt:desc&cursor=…` with the board's filters; loaded pages are tied to one board fetch
(`dataUpdatedAt`) and reset when it refetches. Drag and drop: `@dnd-kit/core` (`PointerSensor` with a 6 px activation
distance so links still click; `KeyboardSensor` whose coordinate getter jumps ←/→ one column; announcements +
screen-reader instructions). Drop on an open stage = optimistic `setQueryData` on `keys.dealBoard` (count, total,
card), then `useMoveDealStage`; failure restores the snapshot and toasts. Drop on Won/Lost opens `CloseDealDialog`
and moves nothing. Show closed off: Won/Lost show "Drop here to close". Below md: one column + stage selector, and a
"Move to…" menu per card instead of dragging. Tests fake column rects (`getBoundingClientRect`) to drive keyboard drags.

**Create — `create-deal-dialog.tsx`** (shell-hosted, `useCreateDealDialog`): react-hook-form + Zod; ContactPicker (or the
fixed `contact` from a contact page; `companyId` limits the picker on a company page); name optional (placeholder =
the default name from `defaultDealName(useContact(id))`; empty → backend default); stage (open stages); amount; expected
close; owner ("Contact's owner" default = `ownerId` omitted; another owner goes in the same POST, C5).
Success opens the deal, or with `stay` toasts "Deal created" with an Open action.

**Close — `close-deal-dialog.tsx`**: one component for the board, the record and lists; `mode` won | lost | reopen.
Won: amount + close date (= expected close date; PATCH only what changed, then stage won) and "If this is the
contact's only open deal, the contact is also marked Won." Lost: reason (required, existing loss-reason labels), notes,
"What happens to the contact?" radios → one `POST /deals/:id/stage` with `contactAction`. Reopen: pick an open stage.
Backend 400/409 render inline (`role="alert"`); the dialog stays open.

**Record — `deal-record-page.tsx` + `deal-about.tsx`** (route `routes/deals.$dealId.tsx`): fetched by id (`useDeal`),
404 → EmptyState. Header: name, stage pill, amount, close date, contact + company links, owner select; Mark won / Mark
lost / Move stage ▾ (open stages) or Reopen; Schedule meeting / Send proposal (existing dialogs with `dealId` and the
deal's contact). `StageProgress` bar: open stage → move at once, Won/Lost → Close dialog. Lost banner (reason + notes).
About: inline name / amount / expected close / owner / company (CompanyPicker, "Remove company"); read-only currency,
source, created, closed. Tabs: Overview (key facts, next meeting, latest proposal, `ActivityFeed dealId limit={5}`),
Activity (`ActivityFeed dealId`), Meetings & proposals (from the detail's `meetings`/`proposals`). Right: contact,
company, other deals of the contact (`useDeals({ leadId, status: "all" })`).

**Data layer**: `useDeals`, `useDealsCount`, `useDealBoard`, `useDeal`, `useDealTimeline`, `useCreateDeal`,
`useUpdateDeal`, `useMoveDealStage`, `useContactSearch`. Every deal key starts with `keys.deals(ws)` (`dealList`,
`dealCount`, `dealBoard`, `deal`, `dealTimeline`), and every deal write calls `refreshDeal(client, ws)` (= `refreshCompany`:
every deal query, contact and company view, global search) because a move can change the contact and company totals.
Activity chips gained **Proposals** (server kind `proposals`); `ActivityFeed` takes `contactId | companyId | dealId`.

## 9. Work pages (C6a) — Tasks, Meetings, Proposals

Same index pattern (§5, §5a) over the C6a list endpoints (`B4-api.md` §7a). Files: `features/tasks/`, `features/meetings/`,
`features/proposals/`, shared pieces in `features/work/`.

**Default view on a bare URL.** A `ListViewSpec` may set `defaultView`: a URL with no params at all is replaced
(history `replace`) by that built-in view with `view=` written, and the page waits (`landing`) instead of fetching
everything first. With a default view no built-in may use the id `all` (applying it would clear the URL and land on
the default again) — the "everything" views are `everyone`. Record pages' "View all" links pass `view=everyone` plus the
record filter (`contactId` / `companyId` / `dealId`).

**Tasks — `/tasks`** (`tasks-search.ts`, `tasks-page.tsx`, `task-columns.tsx`, `task-sheet.tsx`, `done-toggle.tsx`)
- Views (saved views object `tasks`): My open (**default**) · Overdue · Due today (both with counts) · Upcoming ·
  Completed — all `ownerId=me` — and All open (`everyone`). Filters: Owner, Type, Origin (Manual / Automation / AI Agent),
  Due date (whole IST days), Status (More), Contact (`ContactFilter`), Company (`CompanyPicker` chip), Deal chip from links.
- The **Done** toggle sits in the Title cell (`role=checkbox`): a plain task completes optimistically
  (`useCompleteTask`: every loaded task list updated at once, restored on error); a `call` task opens Log call (the call
  completes it), a `schedule_meeting` task opens Schedule meeting. Due is red when the row's `isOverdue`.
- Sheet: details, Complete, Log call, Reschedule (IST date + time), Reassign, Cancel (optional reason).
- Bulk: Complete and Reassign to… with a confirm naming the count; per-task failures summarised in one toast.

**Meetings — `/meetings`** (`meetings-search.ts`, `meetings-page.tsx`, `meeting-columns.tsx`, `meeting-sheet.tsx`,
`meeting-status-icons.tsx`, `meeting-labels.ts`)
- Views (object `meetings`): Upcoming (**default**) · Today · Needs outcome (count) · Completed · Cancelled · All.
  Filters: Owner, Status, Date, Contact, Company, Deal chip.
- Calendar / Notify columns are icons with the status and error as `title` + `aria-label` (`StatusIcon`); Link = Join.
- Sheet: details, Join, Edit / reschedule (`ScheduleMeetingFlow` with the meeting), Record outcome
  (`features/work/meeting-outcome-dialog.tsx`; hidden once completed or cancelled — B33 unchanged), Cancel meeting
  (confirm → PATCH `status: cancelled`). Participants are not shown (the API does not return them — A18).
- Below md (`useMediaQuery("(max-width: 767px)")`) rows are cards (date, status, title, contact) + Load more.

**Proposals — `/proposals`** (`proposals-search.ts`, `proposals-page.tsx`, `proposal-columns.tsx`, `proposal-send-icons.tsx`)
- Header stats Open / Sent / Open pipeline (INR, `Money compact`) from `GET /proposals/summary` with the page's
  filters minus `group`/`status`. Views (object `proposals`): Open (**default**) · Awaiting decision · Won · Lost · All —
  each a backend `group`. Filters: Owner, Status, Updated, Contact, Company, Deal chip.
- Sheet (follows the polled row): details, document name, send statuses, **Change status** → `ProposalStatusDialog`.
  "New proposal" = `SendProposalDialog` with a ContactPicker. There is no document download link yet (no signed-URL
  endpoint exists).
- **B19 display**: `useProposalList` polls every 8 s only while a loaded row's WhatsApp send is queued/sending and its
  `updatedAt` is under 2 minutes old (`lib/proposal-sending.ts`); older rows show "Still sending — check later".

**Shared work dialogs (`features/work/`)**
- `CreateTaskDialog` (shell-hosted, `useCreateTaskDialog().open({ contact? })`): react-hook-form + Zod; ContactPicker or
  the fixed contact (contact record; the deal's contact on a deal record); type; title; due date + time (IST, default
  tomorrow 10:00); owner ("Contact's owner" default, resolved from `useContact`). Errors inline.
- `ScheduleMeetingFlow`: `ScheduleMeetingDialog` + save (create, or reschedule = PATCH with `status: rescheduled`). Without
  `leadId` the dialog asks with a ContactPicker (+ Create → Meeting). `ScheduleMeetingDialog` / `SendProposalDialog` no
  longer load the leads list.
- `LogCallFlow` (**B12**): the one place `LogCallDialog` mounts, with its prompts — nurture outcome → Enroll; Positive /
  Meeting Agreed → Schedule meeting, then (Meeting Agreed) Enroll after the meeting is saved. Each dialog mounts only
  while open; the flow stays mounted so a prompt can follow the call dialog closing. Used by the contact record, the deal
  record and the Tasks page.
- `LogCallDialog` callback (**B13**): date + time (IST); default today 10:00 while ahead, else the next working day
  (Mon–Fri) 10:00; "The callback must be in the future." inline and Save disabled before sending; the backend rule stays.
- `ProposalStatusDialog` (**B4**): offers only the row's `allowedNextStatuses`; Rejected / Expired require a loss reason
  (existing labels) + notes (`LOSS_REASON_STATUSES` in `work-labels.ts` mirrors the backend; a 400 still shows inline);
  a final status says "Create a new proposal instead". Replaces every per-row status `<Select>`.
- `ContactFilter` / `DealFilterChip` (`work-filters.tsx`), `RefLink`, `RecordWorkCards` (company record Related column:
  open tasks, upcoming meetings, open proposals with counts and View all).

**Data layer** (`store/work-hooks.ts`): `useTaskList`, `useTaskCount`, `useMeetingList`, `useMeetingCount`,
`useProposalList`, `useProposalCount`, `useProposalSummary`, `useCreateTask`, `useUpdateTask`, `useCancelTask`,
`useCompleteTask`, `useCreateMeeting`, `useUpdateMeeting`, `useRecordMeetingOutcome`, `useCreateProposal`,
`useSetProposalStatus`. Keys under `keys.work(ws)` (`workList`, `workCount`, `proposalSummary`). Every write calls
`refreshWork(client, ws)` (= `refreshDeal`: work lists, contacts, companies, deals); `refreshContact` also refreshes
`keys.work`. The old `useTasks` / `useMeetings` / `useProposals` (unpaginated) remain only for the unrouted lead page (C6b).

**Bundle**: first load 286.2 → 291.5 kB gzip (the three routes' search schemas, which every route's `validateSearch`
puts in the entry, and the sidebar's overdue count); every work dialog is lazy or route-split.
`src/test/bundle-size.test.ts` proves `checkBudget` (exported by `scripts/check-bundle-size.mjs`) fails above the budget.

