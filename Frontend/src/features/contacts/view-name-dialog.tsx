import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Name (+ "share with the workspace") for saving or renaming a list view. */
export function ViewNameDialog({
  open,
  onOpenChange,
  title,
  initialName = "",
  initialShared = false,
  showShare,
  saving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initialName?: string;
  initialShared?: boolean;
  showShare: boolean;
  saving: boolean;
  onSave: (value: { name: string; isShared: boolean }) => void;
}) {
  const [name, setName] = useState(initialName);
  const [shared, setShared] = useState(initialShared);
  const [loaded, setLoaded] = useState(false);
  // Always mounted: reset to the initial values each time it opens.
  if (open && !loaded) {
    setLoaded(true);
    setName(initialName);
    setShared(initialShared);
  }
  if (!open && loaded) setLoaded(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onSave({ name: name.trim(), isShared: shared });
          }}
        >
          <div>
            <Label htmlFor="view-name" className="mb-1.5 block text-xs">
              View name
            </Label>
            <Input
              id="view-name"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          {showShare && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={shared} onCheckedChange={(v) => setShared(v === true)} />
              Share with everyone in this workspace
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
