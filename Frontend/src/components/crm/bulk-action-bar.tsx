import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Floating bar while rows are selected: count, page-supplied actions, clear. */
export function BulkActionBar({
  count,
  actions,
  onClear,
}: {
  count: number;
  actions?: ReactNode;
  onClear: () => void;
}) {
  if (count === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="fixed inset-x-3 bottom-4 z-40 mx-auto flex max-w-xl flex-wrap items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-lg sm:inset-x-6"
    >
      <span className="mr-auto text-sm font-medium num">{count} selected</span>
      {actions}
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label="Clear selection"
        onClick={onClear}
      >
        <X />
      </Button>
    </div>
  );
}
