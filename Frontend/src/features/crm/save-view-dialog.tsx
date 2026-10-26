import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { messageFromError } from "@/store";

const schema = z.object({
  name: z.string().trim().min(1, "Name the view.").max(100, "Keep the name under 100 characters."),
  isShared: z.boolean(),
});
type SaveViewForm = z.infer<typeof schema>;

/** "Save as new": name + share with the team. Backend errors (e.g. the 30-view limit) inline. */
export function SaveViewDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (value: SaveViewForm) => Promise<unknown>;
}) {
  const form = useForm<SaveViewForm>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", isShared: false },
  });
  const { reset } = form;
  useEffect(() => {
    if (open) reset({ name: "", isShared: false });
  }, [open, reset]);
  const errors = form.formState.errors;

  const submit = form.handleSubmit(async (value) => {
    try {
      await onSave({ name: value.name.trim(), isShared: value.isShared });
    } catch (error) {
      form.setError("root", { message: messageFromError(error) });
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Save view</DialogTitle>
          <DialogDescription>Saves the current filters, sort and columns.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
          <div>
            <Label htmlFor="view-name" className="mb-1.5 block text-xs">
              View name
            </Label>
            <Input
              id="view-name"
              autoFocus
              aria-invalid={Boolean(errors.name)}
              {...form.register("name")}
            />
            {errors.name && <p className="mt-1 text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <Controller
            control={form.control}
            name="isShared"
            render={({ field }) => (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(v) => field.onChange(v === true)}
                />
                Share with the team
              </label>
            )}
          />
          {errors.root && (
            <p role="alert" className="text-sm text-destructive">
              {errors.root.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
