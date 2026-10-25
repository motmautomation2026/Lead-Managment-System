import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { dateInputValue, toIsoFromIst } from "@/lib/dates";
import { label } from "@/lib/labels";
import { useSession } from "@/store";
import { LEAD_LOSS_REASONS, TASK_TYPES, type LeadLossReason, type TaskType } from "@/types";

// Dialogs shared by the contact record page (and the old lead page until C6).

export function SelectField({
  label: name,
  value,
  options,
  onChange,
  optionLabel = label,
  disabled,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  optionLabel?: (value: string) => string;
  disabled?: boolean;
}) {
  return (
    <div>
      <Label className="mb-1.5 block text-xs">{name}</Label>
      <Select
        value={value}
        onValueChange={onChange}
        {...(disabled !== undefined ? { disabled } : {})}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {optionLabel(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function ReasonDialog({
  open,
  title,
  action,
  value,
  onValue,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  action: string;
  value: string;
  onValue: (value: string) => void;
  onOpenChange: (value: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div>
          <Label className="mb-1.5 block text-xs">Reason</Label>
          <Textarea rows={3} value={value} onChange={(event) => onValue(event.target.value)} />
          <p className="pt-2 text-xs text-muted-foreground">{action}</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!value.trim()} onClick={onConfirm}>
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A loss reason is required (not just free text) so the reactivation approach/content can be chosen automatically later. */
export function LostReasonDialog({
  open,
  lossReason,
  onLossReason,
  notes,
  onNotes,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  lossReason: LeadLossReason | "";
  onLossReason: (value: LeadLossReason | "") => void;
  notes: string;
  onNotes: (value: string) => void;
  onOpenChange: (value: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark Lost</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="mb-1.5 block text-xs">Loss reason</Label>
            <Select
              value={lossReason}
              onValueChange={(value) => onLossReason(value as LeadLossReason)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a reason" />
              </SelectTrigger>
              <SelectContent>
                {LEAD_LOSS_REASONS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {label(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">Notes (optional)</Label>
            <Textarea rows={3} value={notes} onChange={(event) => onNotes(event.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">
            Drives the reactivation approach used later - required to close a lead as Lost.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!lossReason} onClick={onConfirm}>
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NextActionDialog({
  open,
  onOpenChange,
  defaultOwner,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  defaultOwner: string;
  initial?: { taskId: string; type: TaskType; title: string; dueAt: string; ownerId: string };
  onSave: (value: { type: TaskType; title: string; dueAt: string; ownerId: string }) => void;
}) {
  const { users } = useSession();
  const [type, setType] = useState<TaskType>("call");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(dateInputValue(1));
  const [owner, setOwner] = useState(defaultOwner);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // This dialog is always mounted (only `open` toggles), so useState
  // initializers only ever run once — re-sync from `initial` here whenever
  // it identifies a different task (or "new") than what's currently loaded,
  // the same pattern TemplateDialog uses. Without this, reopening
  // "Reschedule" after the first save/close shows stale first-mount values.
  const key = initial?.taskId ?? "new";
  if (open && loadedFor !== key) {
    setLoadedFor(key);
    setType(initial?.type ?? "call");
    setTitle(initial?.title ?? "");
    setDue(
      initial
        ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
            new Date(initial.dueAt),
          )
        : dateInputValue(1),
    );
    setOwner(initial?.ownerId ?? defaultOwner);
  }
  if (!open && loadedFor !== null) setLoadedFor(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set next action</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <SelectField
            label="Type"
            value={type}
            options={TASK_TYPES}
            onChange={(value) => setType(value as TaskType)}
          />
          <div>
            <Label className="mb-1.5 block text-xs">Title</Label>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">Due date</Label>
            <Input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
          </div>
          <SelectField
            label="Owner"
            value={owner}
            options={users.map((user) => user.id)}
            optionLabel={(id) => users.find((user) => user.id === id)?.name ?? "Unassigned"}
            onChange={setOwner}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!title.trim() || !owner}
            onClick={() => {
              onSave({ type, title: title.trim(), dueAt: toIsoFromIst(due), ownerId: owner });
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
