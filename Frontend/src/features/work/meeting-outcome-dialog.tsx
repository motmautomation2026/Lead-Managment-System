import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { label } from "@/lib/labels";
import { MEETING_OUTCOMES, type MeetingOutcome } from "@/types";

/** Record a meeting's outcome (the backend routes it); moved from the old Meetings page (C6a). */
export function OutcomeDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onSave: (outcome: MeetingOutcome, notes: string) => void;
}) {
  const [outcome, setOutcome] = useState<MeetingOutcome>("proposal_required");
  const [notes, setNotes] = useState("");
  const [loadedFor, setLoadedFor] = useState(false);

  // Reset on every open (including Cancel, not just a successful save) —
  // this dialog is always mounted, so without this a pick from a previous
  // meeting (even one that was cancelled, not saved) carries over silently.
  if (open && !loadedFor) {
    setLoadedFor(true);
    setOutcome("proposal_required");
    setNotes("");
  }
  if (!open && loadedFor) setLoadedFor(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record meeting outcome</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="mb-1.5 block text-xs">Outcome</Label>
            <Select value={outcome} onValueChange={(value) => setOutcome(value as MeetingOutcome)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEETING_OUTCOMES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {label(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">Notes</Label>
            <Textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSave(outcome, notes);
              setNotes("");
            }}
          >
            Save outcome
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
