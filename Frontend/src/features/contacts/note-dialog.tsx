import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/** Add a note to a contact (record page and the list peek / row menu). */
export function NoteDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (body: string) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add note</DialogTitle>
        </DialogHeader>
        <Textarea
          rows={4}
          value={body}
          aria-label="Note"
          onChange={(e) => setBody(e.target.value)}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!body.trim()}
            onClick={() =>
              void onSave(body.trim()).then((ok) => {
                if (!ok) return;
                setBody("");
                onOpenChange(false);
              })
            }
          >
            Add note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
