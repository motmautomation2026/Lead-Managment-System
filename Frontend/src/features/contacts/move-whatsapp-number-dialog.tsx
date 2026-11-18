import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { backend } from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { keys, messageFromError } from "@/store";
import { useWorkspace } from "@/store/workspace-context";

const schema = z.object({
  numberId: z.string().min(1, "Pick a number."),
  reason: z
    .string()
    .trim()
    .min(1, "Say why the contact moves.")
    .max(500, "Keep it under 500 characters."),
});
type MoveForm = z.infer<typeof schema>;

/**
 * E4a rule 6 — admin only: moves a contact to another WhatsApp number with a reason (audited,
 * timeline "WhatsApp number changed to <label>"); its queued messages follow.
 */
export function MoveWhatsAppNumberDialog({
  contactId,
  currentNumberId,
  open,
  onOpenChange,
}: {
  contactId: string;
  currentNumberId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { currentWorkspaceId } = useWorkspace();
  const client = useQueryClient();
  const numbers = useQuery({
    queryKey: keys.connection(currentWorkspaceId, "whatsapp"),
    queryFn: ({ signal }) => backend.connections.whatsapp.get(signal),
    enabled: open,
  });
  const choices = (numbers.data?.numbers ?? []).filter((n) => n.id !== currentNumberId);
  const form = useForm<MoveForm>({
    resolver: zodResolver(schema),
    defaultValues: { numberId: "", reason: "" },
  });
  const { reset } = form;
  useEffect(() => {
    if (open) reset({ numberId: "", reason: "" });
  }, [open, reset]);
  const errors = form.formState.errors;

  const submit = form.handleSubmit(async ({ numberId, reason }) => {
    try {
      const moved = await backend.contacts.changeWhatsAppNumber(contactId, {
        numberId,
        reason: reason.trim(),
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.contact(currentWorkspaceId, contactId) }),
        client.invalidateQueries({ queryKey: keys.contactTimeline(currentWorkspaceId, contactId) }),
      ]);
      toast.success(`WhatsApp number changed to ${moved.whatsappNumber.label}`);
      onOpenChange(false);
    } catch (error) {
      form.setError("root", { message: messageFromError(error) });
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move to another WhatsApp number?</DialogTitle>
          <DialogDescription>
            The contact will hear from the new number from now on; queued messages move with it.
            Their replies on the old number are still recorded.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="move-wa-number">New number</Label>
            <Controller
              control={form.control}
              name="numberId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="move-wa-number" aria-invalid={Boolean(errors.numberId)}>
                    <SelectValue placeholder={numbers.isLoading ? "Loading…" : "Pick a number"} />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        {n.label}
                        {n.connectedPhone ? ` · +${n.connectedPhone}` : ""} ·{" "}
                        {n.status.replaceAll("_", " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {numbers.isError && (
              <p className="type-small text-destructive">{messageFromError(numbers.error)}</p>
            )}
            {numbers.data && choices.length === 0 && (
              <p className="type-small text-muted-foreground">
                This workspace has no other WhatsApp number.
              </p>
            )}
            {errors.numberId && (
              <p className="type-small text-destructive">{errors.numberId.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="move-wa-reason">Reason</Label>
            <Textarea
              id="move-wa-reason"
              rows={3}
              aria-invalid={Boolean(errors.reason)}
              {...form.register("reason")}
            />
            {errors.reason && (
              <p className="type-small text-destructive">{errors.reason.message}</p>
            )}
          </div>
          {errors.root && <p className="type-small text-destructive">{errors.root.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              Move
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
