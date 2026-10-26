import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ErrorBlock } from "@/components/common/server-state";
import { Money } from "@/components/crm/money";
import { UserAvatar } from "@/components/crm/user-avatar";
import { backend } from "@/lib/backend-client";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { keys, messageFromError, useDealBoard, useMoveDealStage } from "@/store";
import { useWorkspace } from "@/store/workspace-context";
import {
  DEAL_STAGES,
  type DealBoardColumn,
  type DealListItem,
  type DealListParams,
  type DealStage,
} from "@/types";
import { CloseDealDialog } from "./close-deal-dialog";
import { closeDate } from "./deal-columns";
import { DEAL_STAGE_LABELS, isClosedStage } from "./deal-labels";

type BoardData = { data: DealBoardColumn[] };
/** Cards a column loaded with "Load more", plus where to continue. Keyed to one board fetch. */
type Extra = {
  at: number;
  byStage: Partial<Record<DealStage, { items: DealListItem[]; cursor: string | null }>>;
};

const inr = (d: DealListItem) => (d.currency === "INR" ? (d.amount ?? 0) : 0);

/** Keyboard dragging: ←/→ jump to the next stage column (dnd-kit's default steps 25 px). */
const columnKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  if (event.code !== "ArrowRight" && event.code !== "ArrowLeft") return undefined;
  event.preventDefault();
  const { collisionRect, droppableRects, droppableContainers } = context;
  if (!collisionRect) return undefined;
  const center = (r: { left: number; width: number }) => r.left + r.width / 2;
  const from = center(collisionRect);
  const right = event.code === "ArrowRight";
  let best: { left: number; width: number } | undefined;
  for (const container of droppableContainers.getEnabled()) {
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    const x = center(rect);
    if (right ? x <= from + 1 : x >= from - 1) continue;
    if (!best || Math.abs(x - from) < Math.abs(center(best) - from)) best = rect;
  }
  return best ? { x: center(best) - collisionRect.width / 2, y: collisionRect.top } : undefined;
};

/**
 * Pipeline board over GET /deals/board: the 8 stages in order (count, INR total, first 20 cards,
 * "Load more" per column via GET /deals?stage=…&cursor=…). Drag a card (pointer or keyboard) to an
 * open stage → optimistic move + POST /deals/:id/stage, rolled back with a toast on failure; drop on
 * Won/Lost → the Close dialog, nothing moves until it's confirmed. Below md: one stage at a time
 * and a "Move to…" menu on each card instead of dragging.
 */
export function DealBoard({
  params,
  showClosed,
  onShowClosedChange,
}: {
  params: DealListParams;
  showClosed: boolean;
  onShowClosedChange: (on: boolean) => void;
}) {
  const client = useQueryClient();
  const { currentWorkspaceId: ws } = useWorkspace();
  const board = useDealBoard(params);
  const move = useMoveDealStage();
  const desktop = useMediaQuery("(min-width: 768px)");
  const [extraState, setExtra] = useState<Extra>({ at: 0, byStage: {} });
  const [loadingMore, setLoadingMore] = useState<DealStage | null>(null);
  const [closing, setClosing] = useState<{ deal: DealListItem; mode: "won" | "lost" } | null>(null);
  const [mobileStage, setMobileStage] = useState<DealStage>("qualified");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnKeyboardCoordinates }),
  );

  const { stage: _stage, sort: _sort, limit: _limit, ...filters } = params;
  const boardKey = keys.dealBoard(ws, filters);
  // "Load more" pages belong to one board fetch; a refetch starts the columns over.
  const extra = extraState.at === board.dataUpdatedAt ? extraState.byStage : {};
  const columns = board.data?.data ?? [];
  const cardsOf = (col: DealBoardColumn) => [...col.items, ...(extra[col.stage]?.items ?? [])];
  const findDeal = (id: string) => {
    for (const col of columns) {
      const deal = cardsOf(col).find((d) => d.id === id);
      if (deal) return deal;
    }
    return undefined;
  };

  const loadMore = async (col: DealBoardColumn) => {
    const cursor = extra[col.stage]?.cursor ?? col.nextCursor;
    if (!cursor) return;
    setLoadingMore(col.stage);
    try {
      const page = await backend.deals.list(
        { ...filters, stage: [col.stage], sort: "updatedAt:desc" },
        cursor,
      );
      setExtra({
        at: board.dataUpdatedAt,
        byStage: {
          ...extra,
          [col.stage]: {
            items: [...(extra[col.stage]?.items ?? []), ...page.data],
            cursor: page.nextCursor,
          },
        },
      });
    } catch (error) {
      toast.error(messageFromError(error));
    } finally {
      setLoadingMore(null);
    }
  };

  /** Drop / "Move to…": won/lost open the Close dialog; open stages move optimistically. */
  const moveTo = async (deal: DealListItem, to: DealStage) => {
    if (deal.stage === to) return;
    if (isClosedStage(to)) {
      setClosing({ deal, mode: to as "won" | "lost" });
      return;
    }
    await client.cancelQueries({ queryKey: boardKey });
    const snapshot = client.getQueryData<BoardData>(boardKey);
    const extraSnapshot = extraState;
    client.setQueryData<BoardData>(boardKey, (old) =>
      old
        ? {
            data: old.data.map((col) =>
              col.stage === deal.stage
                ? {
                    ...col,
                    count: col.count - 1,
                    amountTotal: col.amountTotal - inr(deal),
                    items: col.items.filter((d) => d.id !== deal.id),
                  }
                : col.stage === to
                  ? {
                      ...col,
                      count: col.count + 1,
                      amountTotal: col.amountTotal + inr(deal),
                      items: [{ ...deal, stage: to }, ...col.items],
                    }
                  : col,
            ),
          }
        : old,
    );
    const from = extra[deal.stage];
    if (from) {
      setExtra({
        at: board.dataUpdatedAt,
        byStage: {
          ...extra,
          [deal.stage]: { ...from, items: from.items.filter((d) => d.id !== deal.id) },
        },
      });
    }
    try {
      await move.mutateAsync({ id: deal.id, stage: to });
    } catch (error) {
      client.setQueryData(boardKey, snapshot);
      setExtra(extraSnapshot);
      toast.error(`Couldn't move “${deal.name}”: ${messageFromError(error)}`);
    }
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const deal = findDeal(String(active.id));
    if (deal && over) void moveTo(deal, over.id as DealStage);
  };

  const nameOf = (id: string | number) => findDeal(String(id))?.name ?? "The deal";
  const stageOf = (id: string | number) => DEAL_STAGE_LABELS[id as DealStage] ?? String(id);
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${nameOf(active.id)}. Use the left and right arrow keys to move it to another stage, Space to drop it, Escape to cancel.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} is over ${stageOf(over.id)}.`
        : `${nameOf(active.id)} is not over a stage.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} was dropped on ${stageOf(over.id)}.`
        : `${nameOf(active.id)} was dropped.`,
    onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} was cancelled.`,
  };

  const toolbar = (
    <div className="flex flex-wrap items-center gap-3">
      {!desktop && (
        <Select value={mobileStage} onValueChange={(v) => setMobileStage(v as DealStage)}>
          <SelectTrigger className="w-full sm:w-64" aria-label="Stage">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEAL_STAGES.map((s) => {
              const col = columns.find((c) => c.stage === s);
              return (
                <SelectItem key={s} value={s}>
                  {DEAL_STAGE_LABELS[s]}
                  {col ? ` (${col.count})` : ""}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      )}
      <div className="flex items-center gap-2">
        <Switch id="show-closed" checked={showClosed} onCheckedChange={onShowClosedChange} />
        <Label htmlFor="show-closed" className="type-small">
          Show closed
        </Label>
      </div>
    </div>
  );

  if (board.error) return <ErrorBlock error={board.error} />;

  const visible = desktop ? columns : columns.filter((c) => c.stage === mobileStage);
  return (
    <div className="space-y-3">
      {toolbar}
      {board.isLoading ? (
        <div className="flex gap-3 overflow-hidden" aria-label="Loading board">
          {Array.from({ length: desktop ? 4 : 1 }, (_, i) => (
            <Skeleton key={i} className="h-80 w-72 shrink-0 rounded-lg" />
          ))}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          onDragEnd={onDragEnd}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable:
                "To move a deal, press Space, use the left and right arrow keys to choose a stage, then press Space again. Escape cancels.",
            },
          }}
        >
          <div className="flex gap-3 overflow-x-auto pb-3" role="list" aria-label="Pipeline">
            {visible.map((col) => (
              <BoardColumn
                key={col.stage}
                column={col}
                cards={cardsOf(col)}
                hidden={isClosedStage(col.stage) && !showClosed}
                hasMore={Boolean(extra[col.stage] ? extra[col.stage]!.cursor : col.nextCursor)}
                loadingMore={loadingMore === col.stage}
                onLoadMore={() => void loadMore(col)}
                draggable={desktop}
                onMoveTo={(deal, to) => void moveTo(deal, to)}
                fullWidth={!desktop}
              />
            ))}
          </div>
        </DndContext>
      )}
      <CloseDealDialog
        deal={closing?.deal ?? null}
        mode={closing?.mode ?? "won"}
        open={Boolean(closing)}
        onOpenChange={(open) => !open && setClosing(null)}
      />
    </div>
  );
}

function BoardColumn({
  column,
  cards,
  hidden,
  hasMore,
  loadingMore,
  onLoadMore,
  draggable,
  onMoveTo,
  fullWidth,
}: {
  column: DealBoardColumn;
  cards: DealListItem[];
  /** Won/Lost with "Show closed" off: a drop target only. */
  hidden: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  draggable: boolean;
  onMoveTo: (deal: DealListItem, to: DealStage) => void;
  fullWidth: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.stage });
  const name = DEAL_STAGE_LABELS[column.stage];
  return (
    <section
      ref={setNodeRef}
      role="listitem"
      aria-label={name}
      data-stage={column.stage}
      className={cn(
        "flex max-h-[calc(100dvh-16rem)] min-h-40 shrink-0 flex-col rounded-lg border bg-muted/40",
        fullWidth ? "w-full" : "w-72",
        isOver && "border-primary bg-accent",
      )}
    >
      <header className="flex items-baseline justify-between gap-2 border-b px-3 py-2">
        <h2 className="truncate type-label">
          {name} <span className="num font-normal text-muted-foreground">({column.count})</span>
        </h2>
        {!hidden && (
          <Money amount={column.amountTotal} compact className="type-small text-muted-foreground" />
        )}
      </header>
      {hidden ? (
        <p className="m-2 flex flex-1 items-center justify-center rounded-md border border-dashed p-4 text-center type-small text-muted-foreground">
          Drop here to close
        </p>
      ) : (
        <div className="flex-1 space-y-2 overflow-y-auto p-2">
          {cards.length === 0 && (
            <p className="py-6 text-center type-small text-muted-foreground">No deals</p>
          )}
          {cards.map((deal) => (
            <DealCard key={deal.id} deal={deal} draggable={draggable} onMoveTo={onMoveTo} />
          ))}
          {hasMore && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function DealCard({
  deal,
  draggable,
  onMoveTo,
}: {
  deal: DealListItem;
  draggable: boolean;
  onMoveTo: (deal: DealListItem, to: DealStage) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: deal.id,
    disabled: !draggable,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...(draggable ? { ...attributes, ...listeners } : {})}
      aria-label={draggable ? `${deal.name}, ${DEAL_STAGE_LABELS[deal.stage]}` : undefined}
      className={cn(
        "space-y-1.5 p-3 shadow-xs",
        draggable && "cursor-grab touch-none",
        isDragging && "relative z-10 opacity-80 shadow-lg",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          to="/deals/$dealId"
          params={{ dealId: deal.id }}
          className="min-w-0 type-body font-medium break-words hover:underline"
        >
          {deal.name}
        </Link>
        {!draggable && <MoveToMenu deal={deal} onMoveTo={onMoveTo} />}
      </div>
      <p className="truncate type-small text-muted-foreground">
        {[deal.company?.name, deal.contact.name].filter(Boolean).join(" · ")}
      </p>
      <div className="flex items-center justify-between gap-2 type-small">
        <span className="flex min-w-0 items-center gap-2">
          {deal.amount !== null && <Money amount={deal.amount} currency={deal.currency} compact />}
          {deal.expectedCloseDate && (
            <span className="truncate text-muted-foreground">
              Close {closeDate(deal.expectedCloseDate)}
            </span>
          )}
        </span>
        <UserAvatar name={deal.owner?.name} size="sm" />
      </div>
    </Card>
  );
}

function MoveToMenu({
  deal,
  onMoveTo,
}: {
  deal: DealListItem;
  onMoveTo: (deal: DealListItem, to: DealStage) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={`Move ${deal.name} to…`}
        >
          <ArrowRightLeft className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Move to…</DropdownMenuLabel>
        {DEAL_STAGES.filter((s) => s !== deal.stage).map((s) => (
          <DropdownMenuItem key={s} onSelect={() => onMoveTo(deal, s)}>
            {DEAL_STAGE_LABELS[s]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
