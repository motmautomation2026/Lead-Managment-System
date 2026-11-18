import { useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Check, GripVertical, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { messageFromError, useDeleteSavedView, useUpdateSavedView } from "@/store";
import type { SavedView } from "@/types";
import { canEditView } from "./saved-views";

/**
 * Manage an index page's saved views: rename inline, reorder by drag (keyboard too: Space,
 * ↑/↓, Space) → PATCH position, share own views, delete with confirm. Rights as the API:
 * own views; admins also shared ones. Others' views are listed without controls.
 * Positions are one order for everyone: only views you may edit move; others keep theirs.
 */
export function ManageViewsDialog({
  open,
  onOpenChange,
  views,
  isAdmin,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  views: SavedView[];
  isAdmin: boolean;
  onDeleted: (id: string) => void;
}) {
  const update = useUpdateSavedView();
  const remove = useDeleteSavedView();
  const [error, setError] = useState<string | null>(null);
  // Local order while a reorder saves; null = the server's order.
  const [order, setOrder] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState<SavedView | null>(null);
  const byId = new Map(views.map((v) => [v.id, v]));
  const ids = (order ?? views.map((v) => v.id)).filter((id) => byId.has(id));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      return true;
    } catch (e) {
      setError(messageFromError(e));
      return false;
    }
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    setOrder(next);
    const changes = next
      .map((id, position) => ({ view: byId.get(id)!, position }))
      .filter(({ view, position }) => canEditView(view, isAdmin) && view.position !== position);
    void run(() =>
      Promise.all(
        changes.map(({ view, position }) =>
          update.mutateAsync({ id: view.id, input: { position } }),
        ),
      ),
    ).then(() => setOrder(null));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage views</DialogTitle>
          <DialogDescription>
            Your views and the ones shared with the team. Drag to reorder.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p
            role="alert"
            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground"
          >
            {error}
          </p>
        )}
        {ids.length === 0 ? (
          <p className="type-body text-muted-foreground">
            No saved views yet. Filter the list, then use &ldquo;Save as new&rdquo;.
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <ul className="max-h-[60dvh] space-y-1 overflow-y-auto" aria-label="Saved views">
                {ids.map((id) => {
                  const view = byId.get(id)!;
                  return (
                    <ViewRow
                      key={id}
                      view={view}
                      canEdit={canEditView(view, isAdmin)}
                      onRename={(name) => run(() => update.mutateAsync({ id, input: { name } }))}
                      onShare={(isShared) =>
                        void run(() => update.mutateAsync({ id, input: { isShared } }))
                      }
                      onDelete={() => setDeleting(view)}
                    />
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
        <ConfirmDialog
          open={deleting !== null}
          onOpenChange={(o) => !o && setDeleting(null)}
          title={`Delete the view "${deleting?.name ?? ""}"?`}
          description={
            deleting?.isShared
              ? "It is shared, so it disappears for everyone in this workspace. Records are not affected."
              : "Records are not affected."
          }
          confirmLabel="Delete view"
          confirmVariant="destructive"
          disabled={remove.isPending}
          onConfirm={() => {
            const view = deleting!;
            setDeleting(null);
            void run(() => remove.mutateAsync(view.id)).then((ok) => ok && onDeleted(view.id));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ViewRow({
  view,
  canEdit,
  onRename,
  onShare,
  onDelete,
}: {
  view: SavedView;
  canEdit: boolean;
  onRename: (name: string) => Promise<boolean>;
  onShare: (isShared: boolean) => void;
  onDelete: () => void;
}) {
  const sortable = useSortable({ id: view.id, disabled: !canEdit });
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(view.name);
  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === view.name) return setRenaming(false);
    if (await onRename(trimmed)) setRenaming(false);
  };

  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: sortable.transform
          ? `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0)`
          : undefined,
        transition: sortable.transition,
      }}
      className="flex min-h-11 items-center gap-2 rounded-md border bg-card px-2 py-1.5"
    >
      {canEdit ? (
        <button
          type="button"
          className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-accent"
          aria-label={`Reorder ${view.name}`}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          <GripVertical className="size-4" />
        </button>
      ) : (
        <span className="w-6" aria-hidden />
      )}
      {renaming ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void saveName();
          }}
        >
          <Input
            value={name}
            maxLength={100}
            autoFocus
            aria-label="View name"
            className="h-8"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setName(view.name);
                setRenaming(false);
              }
            }}
          />
          <Button
            type="submit"
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label="Save name"
          >
            <Check />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label="Cancel rename"
            onClick={() => {
              setName(view.name);
              setRenaming(false);
            }}
          >
            <X />
          </Button>
        </form>
      ) : (
        <span className="min-w-0 flex-1">
          <span className="block truncate type-body">{view.name}</span>
          {!view.isMine && (
            <span className="block type-small text-muted-foreground">Shared by a teammate</span>
          )}
        </span>
      )}
      {view.isMine && (
        <label className="flex shrink-0 items-center gap-1.5 type-small text-muted-foreground">
          <Switch
            checked={view.isShared}
            onCheckedChange={onShare}
            aria-label={`Share ${view.name}`}
          />
          <span className="max-sm:hidden">Shared</span>
        </label>
      )}
      {canEdit && !renaming && (
        <>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            aria-label={`Rename ${view.name}`}
            onClick={() => {
              setName(view.name);
              setRenaming(true);
            }}
          >
            <Pencil />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            aria-label={`Delete ${view.name}`}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </>
      )}
    </li>
  );
}
