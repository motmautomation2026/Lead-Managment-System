import { useState } from "react";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { afterMenuClose } from "@/lib/after-menu-close";
import { toastUndo } from "@/lib/toast-undo";
import { useSession } from "@/store";
import type { IdName } from "@/types";

/** Bulk changes up to this size run at once (with Undo); bigger ones ask first (UX-2 rule). */
const CONFIRM_OVER = 20;

/**
 * UX-3: bulk "Assign owner" on lists whose PATCH already takes `ownerId` (Companies, Deals). One PATCH per
 * row through the record's update mutation (which refreshes the lists; the backend checks the new owner is an
 * active member); Undo puts every row's previous owner back,
 * including "no owner". Selection belongs to one list (`listKey`) and clears when its params change.
 */
export function useBulkAssignOwner<T extends { id: string; owner: IdName | null }>({
  listKey,
  rows,
  noun,
  write,
}: {
  listKey: string;
  rows: T[];
  /** Plural noun for messages, e.g. "companies". */
  noun: [one: string, many: string];
  write: (id: string, ownerId: string | null) => Promise<unknown>;
}) {
  const { users, userName } = useSession();
  const [selection, setSelection] = useState({ key: listKey, ids: [] as string[] });
  const selected = selection.key === listKey ? selection.ids : [];
  const setSelected = (ids: string[]) => setSelection({ key: listKey, ids });
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const count = (n: number) => `${n} ${n === 1 ? noun[0] : noun[1]}`;

  const each = async (ids: string[], ownerOf: (id: string) => string | null) => {
    const ok: string[] = [];
    let first: unknown = null;
    for (const id of ids) {
      try {
        await write(id, ownerOf(id));
        ok.push(id);
      } catch (error) {
        first ??= error;
      }
    }
    return { ok, first };
  };

  const run = async (ownerId: string) => {
    const ids = selected;
    const previous = new Map(
      ids.map((id) => [id, rows.find((r) => r.id === id)?.owner?.id ?? null]),
    );
    setBusy(true);
    const { ok, first } = await each(ids, () => ownerId);
    setBusy(false);
    setSelected([]);
    const failed = ids.length - ok.length;
    const verb = `assigned to ${userName(ownerId)}`;
    if (failed > 0) {
      toast.error(
        `${ok.length} ${verb}, ${failed} failed: ${first instanceof Error ? first.message : "request failed"}`,
      );
      return;
    }
    const changed = ok.filter((id) => previous.get(id) !== ownerId);
    if (changed.length === 0) return void toast.success(`${count(ok.length)} ${verb}`);
    toastUndo(
      `${count(ok.length)} ${verb}`,
      () =>
        void each(changed, (id) => previous.get(id) ?? null).then(({ ok: back }) =>
          back.length === changed.length
            ? toast.success("Owner change undone")
            : toast.error(`Couldn't undo ${count(changed.length - back.length)}`),
        ),
    );
  };

  const ask = (ownerId: string) =>
    selected.length > CONFIRM_OVER
      ? afterMenuClose(() => setPending(ownerId))()
      : void run(ownerId);

  const bulkActions = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" disabled={busy}>
          <UserPlus /> Assign owner
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        {users
          .filter((u) => u.active)
          .map((u) => (
            <DropdownMenuItem key={u.id} onSelect={() => ask(u.id)}>
              {u.name}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const confirmDialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => !open && setPending(null)}
      title="Assign owner"
      description={`Make ${userName(pending ?? "")} the owner of ${count(selected.length)}? You can undo it right after.`}
      confirmLabel="Assign"
      confirmVariant="default"
      disabled={busy}
      onConfirm={() => {
        const ownerId = pending;
        setPending(null);
        if (ownerId) void run(ownerId);
      }}
    />
  );

  return { selected, setSelected, bulkActions, confirmDialog };
}
