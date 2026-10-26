import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BulkActionBar } from "@/components/crm/bulk-action-bar";
import { EmptyState } from "@/components/crm/empty-state";
import { ErrorBlock } from "@/components/common/server-state";
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

/**
 * Server-mode table: the page owns data, sort, paging, selection and visible
 * columns; this renders them. Sorting is single-column (`onSortChange`), paging
 * is "Load more" plus infinite scroll (`onLoadMore` while `hasNextPage`).
 * Rows: click → `onRowClick`; ctrl/⌘/middle-click opens `getRowHref` in a new
 * tab (the first column renders a real link). Keyboard: ↑/↓ move, Enter opens,
 * Space toggles selection. `onRowIntent` fires on mouse/pen hover and focus (prefetch).
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
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const selectable = Boolean(onSelectionChange);
  const selected = useMemo(() => selectedIds ?? [], [selectedIds]);

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
  }, [columns, getRowHref, selectable]);

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
      scrollRef.current?.querySelector<HTMLElement>(`tr[data-row-index="${i}"]`)?.focus(),
    );
  };

  const onRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, index: number) => {
    const row = rows[index];
    if (!row || e.target !== e.currentTarget) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(index + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      openRow(row.original, e.metaKey || e.ctrlKey);
    } else if (e.key === " " && selectable) {
      e.preventDefault();
      row.toggleSelected();
    }
  };

  const visibleLeafs = table.getVisibleLeafColumns();
  const virtualItems = virtualizer.getVirtualItems();
  const items = virtual ? virtualItems : rows.map((_, index) => ({ index }));
  const padTop = virtual ? (virtualItems[0]?.start ?? 0) : 0;
  const padBottom = virtual ? virtualizer.getTotalSize() - (virtualItems.at(-1)?.end ?? 0) : 0;

  const showSkeleton = isLoading && data.length === 0;
  const showError = Boolean(error) && data.length === 0 && !isLoading;
  const showEmpty = !isLoading && !error && data.length === 0;
  const hideableColumns = columns.filter((c) => c.hideable !== false);

  return (
    <div className="space-y-2">
      {onColumnsChange && (
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3 /> Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Show columns</DropdownMenuLabel>
              {hideableColumns.map((c) => {
                const shown = !visibleColumns || visibleColumns.includes(c.id);
                return (
                  <DropdownMenuCheckboxItem
                    key={c.id}
                    checked={shown}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={(on) => {
                      const current = visibleColumns ?? hideableColumns.map((h) => h.id);
                      onColumnsChange(
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
      >
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
                  data-row-index={index}
                  aria-rowindex={index + 1}
                  aria-selected={selectable ? row.getIsSelected() : undefined}
                  tabIndex={index === focusIndex ? 0 : -1}
                  onFocus={() => {
                    setFocusIndex(index);
                    onRowIntent?.(row.original);
                  }}
                  onPointerEnter={(e) => {
                    // Touch "hovers" fire while scrolling: no prefetch for them.
                    if (e.pointerType !== "touch") onRowIntent?.(row.original);
                  }}
                  onKeyDown={(e) => onRowKeyDown(e, index)}
                  onClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest("button, input, label, [role=checkbox]")) return;
                    const newTab = e.metaKey || e.ctrlKey;
                    // A modified click on the link itself is the browser's job.
                    if (target.closest("a")) {
                      if (newTab) return;
                      if (onRowClick) e.preventDefault();
                    }
                    openRow(row.original, newTab);
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1 && !(e.target as HTMLElement).closest("a"))
                      openRow(row.original, true);
                  }}
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
