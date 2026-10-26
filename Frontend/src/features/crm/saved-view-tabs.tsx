import { useState } from "react";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ViewTabs } from "@/components/crm/view-tabs";
import { messageFromError, useCreateSavedView, useUpdateSavedView } from "@/store";
import { ManageViewsDialog } from "./manage-views-dialog";
import { SaveViewDialog } from "./save-view-dialog";
import { toSavedViewBody, type ListViewState } from "./saved-views";
import type { ListViewsController } from "./use-list-views";

/**
 * The view tabs of an index page (Contacts, Companies, Deals): built-in + saved views, an
 * "Edited" marker when the URL drifted from the selected view with Save (PATCH; only views you
 * may edit) / Save as new / Reset (saved views; built-ins only Save as new), and Manage views.
 */
export function SavedViewTabs<S extends ListViewState>({
  controller: c,
}: {
  controller: ListViewsController<S>;
}) {
  const createView = useCreateSavedView();
  const updateView = useUpdateSavedView();
  const [saveOpen, setSaveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const body = () => toSavedViewBody(c.state, c.spec.toApiParams);

  const saveChanges = () =>
    void updateView
      .mutateAsync({ id: c.active!.saved!.id, input: body() })
      .then(() => toast.success("View saved"))
      .catch((error: unknown) => toast.error(messageFromError(error)));

  const saveAsNew = async (value: { name: string; isShared: boolean }) => {
    // New views go last (the API defaults position to 0, i.e. first).
    const position = Math.min(10_000, Math.max(-1, ...c.saved.map((v) => v.position)) + 1);
    const view = await createView.mutateAsync({
      object: c.spec.object,
      ...value,
      ...body(),
      position,
    });
    toast.success("View saved");
    setSaveOpen(false);
    void c.set({ view: view.id } as Partial<S>);
  };

  return (
    <div className="flex flex-wrap items-end gap-x-1">
      <div className="min-w-0 flex-1">
        <ViewTabs
          views={c.views.map((v) => ({
            id: v.id,
            label: v.label,
            edited: v.id === c.activeId && c.edited,
          }))}
          activeId={c.activeId}
          onChange={c.apply}
          onSaveView={() => setSaveOpen(true)}
        />
      </div>
      <div className="mb-1 flex shrink-0 items-center gap-1">
        {c.edited && (
          <>
            {c.canEditActive && (
              <Button
                size="sm"
                variant="ghost"
                disabled={updateView.isPending}
                onClick={saveChanges}
              >
                Save
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSaveOpen(true)}>
              Save as new
            </Button>
            {c.active?.saved && (
              <Button size="sm" variant="ghost" onClick={() => c.apply(c.activeId)}>
                Reset
              </Button>
            )}
          </>
        )}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="View options">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setManageOpen(true)}>Manage views…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <SaveViewDialog open={saveOpen} onOpenChange={setSaveOpen} onSave={saveAsNew} />
      <ManageViewsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        views={c.saved}
        isAdmin={c.isAdmin}
        onDeleted={(id) => {
          toast.success("View deleted");
          if (id === c.activeId) c.apply("all");
        }}
      />
    </div>
  );
}
