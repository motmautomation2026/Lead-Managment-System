import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, Inbox } from "lucide-react";
import { keysAreTaken } from "@/app/shortcuts";
import { useTheme } from "@/app/theme-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BulkActionBar } from "@/components/crm/bulk-action-bar";
import { EmptyState } from "@/components/crm/empty-state";
import { ErrorBlock } from "@/components/common/server-state";
import { PAGE_SIZES, type PageSize } from "@/lib/list-prefs";
import { DENSITIES, type Density } from "@/lib/preferences";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

export interface DataTableColumn<T> {
  /** Column id; also the sort field sent to the API (use the B4 whitelist names). */
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  sortable?: boolean;
  /** Width in px (default 180). */
  size?: number;
  /** false = always shown, not in the column picker. */
  hideable?: boolean;
}

export interface SortState {
  field: string;
  dir: "asc" | "desc";
}

/** Rows beyond this are virtualised. */
const VIRTUALIZE_AFTER = 200;
const SELECT_ID = "__select";
const ACTIONS_ID = "__actions";
/** Clicks on these inside a row belong to the control (they never open the row). */
const ROW_CONTROLS =
  "button, input, label, select, [role=checkbox], [role=combobox], [role=menuitem]";

/**
 * Server-mode table: the page owns data, sort, paging, selection and visible
 * columns; this renders them. Sorting is single-column (`onSortChange`), paging
 * is "Load more" plus infinite scroll (`onLoadMore` while `hasNextPage`).
 * Rows: click → `onRowClick`; ctrl/⌘/middle-click opens `getRowHref` in a new
 * tab (the first column renders a real link). Keyboard: ↑/↓ or j/k move (j/k also start from
 * anywhere on the page outside a field), Enter opens, Space or x toggles selection.
 * `onRowIntent` fires on mouse/pen hover and focus (prefetch). UX-2: rows per page
 * (`pageSize` + `onPageSizeChange`), density in the Columns menu, `rowActions` (a last,
 * always-shown column) and cards instead of a table on phones (< 640 px, no sideways scroll).
 */
export function DataTable<T>({
  label,
  data,
  columns,
  getRowId,
  getRowHref,
  onRowClick,
  onRowIntent,
  sort = null,
  onSortChange,
  visibleColumns,
  onColumnsChange,
  enableResizing = false,
  selectedIds,
  onSelectionChange,
  bulkActions,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
  isLoading = false,
  error,
  onRetry,
  emptyState,
  className,
  pageSize,
  onPageSizeChange,
  rowActions,
}: {
  label: string;
  data: T[];
  columns: DataTableColumn<T>[];
  getRowId: (row: T) => string;
  getRowHref?: (row: T) => string;
  onRowClick?: (row: T) => void;
  onRowIntent?: (row: T) => void;
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  visibleColumns?: string[];
  onColumnsChange?: (ids: string[]) => void;
  enableResizing?: boolean;
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  bulkActions?: ReactNode;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyState?: ReactNode;
  className?: string;
  pageSize?: PageSize;
  onPageSizeChange?: (size: PageSize) => void;
  /** Per-row actions (kebab menu, inline buttons); clicks inside never open the row. */
  rowActions?: (row: T) => ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const selectable = Boolean(onSelectionChange);
  const selected = useMemo(() => selectedIds ?? [], [selectedIds]);
  const phone = useMediaQuery("(max-width: 639px)");
  const { density, setDensity } = useTheme();

  const columnDefs = useMemo<ColumnDef<T>[]>(() => {
    const defs: ColumnDef<T>[] = columns.map((col, i) => ({
      id: col.id,
      header: col.header,
      size: col.size ?? 180,
      enableHiding: col.hideable !== false,
      cell: ({ row }) => {
        const content = col.cell(row.original);
        const href = i === 0 ? getRowHref?.(row.original) : undefined;
        return href ? (
          <a href={href} tabIndex={-1} className="font-medium hover:underline">
            {content}
          </a>
        ) : (
          content
        );
      },
    }));
    if (rowActions)
      defs.push({
        id: ACTIONS_ID,
        size: 56,
        enableResizing: false,
        enableHiding: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => <div className="flex justify-end">{rowActions(row.original)}</div>,
      });
    if (!selectable) return defs;
    return [
      {
        id: SELECT_ID,
        size: 40,
        enableResizing: false,
        enableHiding: false,
        header: ({ table }) => (
          <Checkbox
            aria-label="Select all loaded rows"
            checked={
              table.getIsAllRowsSelected()
                ? true
                : table.getIsSomeRowsSelected()
                  ? "indeterminate"
                  : false
            }
            onCheckedChange={(c) => table.toggleAllRowsSelected(c === true)}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label="Select row"
            checked={row.getIsSelected()}
            onCheckedChange={(c) => row.toggleSelected(c === true)}
          />
        ),
      },
      ...defs,
    ];
  }, [columns, getRowHref, selectable, rowActions]);

  const columnVisibility = useMemo<VisibilityState>(
    () =>
      visibleColumns
        ? Object.fromEntries(
            columns.map((c) => [c.id, c.hideable === false || visibleColumns.includes(c.id)]),
          )
        : {},
    [columns, visibleColumns],
  );
  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries(selected.map((id) => [id, true])),
    [selected],
  );

  const table = useReactTable({
    data,
    columns: columnDefs,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    enableRowSelection: selectable,
    enableColumnResizing: enableResizing,
    columnResizeMode: "onChange",
    state: { columnVisibility, rowSelection },
    onRowSelectionChange: (updater) => {
      const next = typeof updater === "function" ? updater(rowSelection) : updater;
      onSelectionChange?.(Object.keys(next).filter((id) => next[id]));
    },
  });

  const rows = table.getRowModel().rows;
  const virtual = rows.length > VIRTUALIZE_AFTER;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 12,
  });

  // Infinite scroll: load the next page when the sentinel below the rows shows.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage || !onLoadMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) onLoadMore();
      },
      { root: scrollRef.current, rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  const openRow = (row: T, newTab: boolean) => {
    const href = getRowHref?.(row);
    if (newTab && href) window.open(href, "_blank", "noopener");
    else onRowClick?.(row);
  };

  const focusRow = (index: number) => {
    const i = Math.max(0, Math.min(rows.length - 1, index));
    setFocusIndex(i);
    if (virtual) virtualizer.scrollToIndex(i);
    requestAnimationFrame(() =>
      scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${i}"]`)?.focus(),
    );
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLElement>, index: number) => {
    const row = rows[index];
    if (!row || e.target !== e.currentTarget || e.altKey) return;
    const plain = !e.ctrlKey && !e.metaKey;
    const down = e.key === "ArrowDown" || (plain && e.key === "j");
    if (down || e.key === "ArrowUp" || (plain && e.key === "k")) {
      e.preventDefault();
      focusRow(index + (down ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      openRow(row.original, e.metaKey || e.ctrlKey);
    } else if ((e.key === " " || (plain && e.key === "x")) && selectable) {
      e.preventDefault();
      row.toggleSelected();
    }
  };

  // j / k from anywhere on the page (not typing, no dialog or menu open) step into the list.
  // Only the page's first list listens, so a record page with several tables stays quiet.
  const startRef = useRef(() => focusRow(focusIndex));
  startRef.current = () => focusRow(focusIndex);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "j" && e.key !== "k") return;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || keysAreTaken(e.target))
        return;
      const root = scrollRef.current;
      if (!root || document.querySelector("[data-list-table]") !== root) return;
      if (root.contains(document.activeElement)) return;
      e.preventDefault();
      startRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** The same behaviour for a table row and a phone card. */
  const rowProps = (index: number, original: T) => ({
    "data-row-index": index,
    tabIndex: index === focusIndex ? 0 : -1,
    onFocus: () => {
      setFocusIndex(index);
      onRowIntent?.(original);
    },
    onPointerEnter: (e: ReactPointerEvent) => {
      // Touch "hovers" fire while scrolling: no prefetch for them.
      if (e.pointerType !== "touch") onRowIntent?.(original);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => onRowKeyDown(e, index),
    onClick: (e: ReactMouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(ROW_CONTROLS)) return;
      const newTab = e.metaKey || e.ctrlKey;
      // A modified click on the link itself is the browser's job.
      if (target.closest("a")) {
        if (newTab) return;
        if (onRowClick) e.preventDefault();
      }
      openRow(original, newTab);
    },
    onAuxClick: (e: ReactMouseEvent) => {
      if (e.button === 1 && !(e.target as HTMLElement).closest("a")) openRow(original, true);
    },
  });

  const visibleLeafs = table.getVisibleLeafColumns();
  const virtualItems = virtualizer.getVirtualItems();
  const items = virtual ? virtualItems : rows.map((_, index) => ({ index }));
  const padTop = virtual ? (virtualItems[0]?.start ?? 0) : 0;
  const padBottom = virtual ? virtualizer.getTotalSize() - (virtualItems.at(-1)?.end ?? 0) : 0;

  const showSkeleton = isLoading && data.length === 0;
  const showError = Boolean(error) && data.length === 0 && !isLoading;
  const showEmpty = !isLoading && !error && data.length === 0;
  const hideableColumns = columns.filter((c) => c.hideable !== false);
  const sortable = columns.filter((c) => c.sortable);

  return (
    <div className="space-y-2">
      {(onColumnsChange || onPageSizeChange) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {phone && onSortChange && sortable.length > 0 && (
            <Select
              value={sort ? `${sort.field}:${sort.dir}` : ""}
              onValueChange={(v) => {
                const [field = "", dir] = v.split(":");
                onSortChange({ field, dir: dir === "desc" ? "desc" : "asc" });
              }}
            >
              <SelectTrigger className="h-8 w-auto gap-1" aria-label="Sort by">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                {sortable.flatMap((c) => [
                  <SelectItem key={`${c.id}:asc`} value={`${c.id}:asc`}>
                    {c.header} ↑
                  </SelectItem>,
                  <SelectItem key={`${c.id}:desc`} value={`${c.id}:desc`}>
                    {c.header} ↓
                  </SelectItem>,
                ])}
              </SelectContent>
            </Select>
          )}
          {onPageSizeChange && pageSize && (
            <Select
              value={String(pageSize)}
              onValueChange={(v) => onPageSizeChange(Number(v) as PageSize)}
            >
              <SelectTrigger className="h-8 w-auto gap-1" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} per page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3 /> {onColumnsChange ? "Columns" : "View"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Density</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={density}
                onValueChange={(v) => setDensity(v as Density)}
              >
                {DENSITIES.map((d) => (
                  <DropdownMenuRadioItem key={d} value={d} onSelect={(e) => e.preventDefault()}>
                    {d === "compact" ? "Compact" : "Comfortable"}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {onColumnsChange && <DropdownMenuSeparator />}
              {onColumnsChange && <DropdownMenuLabel>Show columns</DropdownMenuLabel>}
              {(onColumnsChange ? hideableColumns : []).map((c) => {
                const shown = !visibleColumns || visibleColumns.includes(c.id);
                return (
                  <DropdownMenuCheckboxItem
                    key={c.id}
                    checked={shown}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={(on) => {
                      const current = visibleColumns ?? hideableColumns.map((h) => h.id);
                      onColumnsChange?.(
                        on
                          ? columns
                              .map((x) => x.id)
                              .filter((id) => id === c.id || current.includes(id))
                          : current.filter((id) => id !== c.id),
                      );
                    }}
                  >
                    {c.header}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div
        ref={scrollRef}
        className={cn(
          "max-h-[calc(100dvh-14rem)] min-h-40 overflow-auto rounded-md border bg-card",
          className,
        )}
        data-list-table
      >
        {phone ? (
          <ul aria-label={label} className="divide-y">
            {showSkeleton &&
              Array.from({ length: 6 }, (_, i) => (
                <li key={i} data-testid="skeleton-row" className="space-y-2 p-3">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </li>
              ))}
            {rows.map((row, index) => {
              const [title, ...rest] = row
                .getVisibleCells()
                .filter((c) => c.column.id !== SELECT_ID && c.column.id !== ACTIONS_ID);
              return (
                <li
                  key={row.id}
                  aria-selected={selectable ? row.getIsSelected() : undefined}
                  {...rowProps(index, row.original)}
                  className={cn(
                    "flex cursor-pointer gap-3 p-3 outline-none focus-visible:bg-accent",
                    row.getIsSelected() && "bg-accent/60",
                  )}
                >
                  {selectable && (
                    <Checkbox
                      aria-label="Select row"
                      checked={row.getIsSelected()}
                      onCheckedChange={(c) => row.toggleSelected(c === true)}
                      className="mt-0.5"
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    {title && (
                      <div className="truncate type-body">
                        {flexRender(title.column.columnDef.cell, title.getContext())}
                      </div>
                    )}
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 type-small">
                      {rest.map((cell) => (
                        <div key={cell.id} className="contents">
                          <dt className="text-muted-foreground">
                            {columns.find((c) => c.id === cell.column.id)?.header}
                          </dt>
                          <dd className="min-w-0 truncate">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                  {rowActions && <div className="shrink-0">{rowActions(row.original)}</div>}
                </li>
              );
            })}
          </ul>
        ) : (
          <table
            aria-label={label}
            aria-rowcount={data.length}
            className="w-full border-separate border-spacing-0 text-sm"
            style={enableResizing ? { width: table.getTotalSize(), minWidth: "100%" } : undefined}
          >
            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header) => {
                    const col = columns.find((c) => c.id === header.column.id);
                    const sorted = sort?.field === header.column.id ? sort.dir : null;
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={
                          sorted === "asc"
                            ? "ascending"
                            : sorted === "desc"
                              ? "descending"
                              : undefined
                        }
                        style={{ width: header.getSize() }}
                        className="sticky top-0 z-10 h-10 border-b bg-surface px-[var(--cell-px)] text-left type-label whitespace-nowrap"
                      >
                        {col?.sortable && onSortChange ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded hover:text-foreground"
                            onClick={() =>
                              onSortChange({
                                field: col.id,
                                dir: sorted === "asc" ? "desc" : "asc",
                              })
                            }
                          >
                            {col.header}
                            {sorted === "asc" ? (
                              <ArrowUp className="size-3.5" aria-hidden />
                            ) : sorted === "desc" ? (
                              <ArrowDown className="size-3.5" aria-hidden />
                            ) : (
                              <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />
                            )}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                        {enableResizing && header.column.getCanResize() && (
                          <div
                            role="separator"
                            aria-orientation="vertical"
                            aria-label={`Resize ${col?.header ?? "column"}`}
                            onMouseDown={header.getResizeHandler()}
                            onTouchStart={header.getResizeHandler()}
                            className={cn(
                              "absolute right-0 top-0 h-full w-1 cursor-col-resize select-none hover:bg-primary/40",
                              header.column.getIsResizing() && "bg-primary",
                            )}
                          />
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {showSkeleton &&
                Array.from({ length: 8 }, (_, i) => (
                  <tr key={i} data-testid="skeleton-row" style={{ height: "var(--row-height)" }}>
                    {visibleLeafs.map((c) => (
                      <td key={c.id} className="border-b px-[var(--cell-px)]">
                        <Skeleton className="h-4 w-3/4" />
                      </td>
                    ))}
                  </tr>
                ))}
              {padTop > 0 && (
                <tr aria-hidden style={{ height: padTop }}>
                  <td colSpan={visibleLeafs.length} />
                </tr>
              )}
              {items.map(({ index }) => {
                const row = rows[index];
                if (!row) return null;
                return (
                  <tr
                    key={row.id}
                    ref={virtual ? virtualizer.measureElement : undefined}
                    data-index={index}
                    aria-rowindex={index + 1}
                    aria-selected={selectable ? row.getIsSelected() : undefined}
                    {...rowProps(index, row.original)}
                    style={{ height: "var(--row-height)" }}
                    className={cn(
                      "cursor-pointer outline-none hover:bg-muted/50 focus-visible:bg-accent focus-visible:shadow-[inset_2px_0_0_var(--color-focus-ring)]",
                      row.getIsSelected() && "bg-accent/60",
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        style={{ width: cell.column.getSize() }}
                        className="max-w-0 truncate border-b px-[var(--cell-px)] py-[var(--cell-py)]"
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {padBottom > 0 && (
                <tr aria-hidden style={{ height: padBottom }}>
                  <td colSpan={visibleLeafs.length} />
                </tr>
              )}
            </tbody>
          </table>
        )}

        {showEmpty && (emptyState ?? <EmptyState icon={Inbox} title="Nothing here yet" />)}
        {showError && (
          <div className="space-y-3 p-4">
            <ErrorBlock error={error} />
            {onRetry && (
              <div className="text-center">
                <Button variant="outline" size="sm" onClick={onRetry}>
                  Try again
                </Button>
              </div>
            )}
          </div>
        )}
        {data.length > 0 && hasNextPage && (
          <div ref={sentinelRef} className="flex justify-center p-3">
            <Button
              variant="outline"
              size="sm"
              disabled={isFetchingNextPage}
              onClick={() => onLoadMore?.()}
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
        {data.length > 0 && Boolean(error) && (
          <div className="flex items-center justify-center gap-2 p-3 text-sm text-destructive">
            Couldn&rsquo;t load more.
            {onRetry && (
              <Button variant="ghost" size="sm" onClick={onRetry}>
                Retry
              </Button>
            )}
          </div>
        )}
      </div>

      {selectable && bulkActions !== undefined && (
        <BulkActionBar
          count={selected.length}
          actions={bulkActions}
          onClear={() => onSelectionChange?.([])}
        />
      )}
    </div>
  );
}
