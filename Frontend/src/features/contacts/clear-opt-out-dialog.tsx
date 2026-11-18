import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
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
import { Textarea } from "@/components/ui/textarea";
import { messageFromError, useLeadMutations } from "@/store";

const schema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Say why the contact may be messaged again.")
    .max(500, "Keep it under 500 characters."),
});
type ClearOptOutForm = z.infer<typeof schema>;

const TEXT = {
  whatsapp: {
    title: "Clear WhatsApp opt-out?",
    description:
      "This contact asked us to stop messaging on WhatsApp. Clear it only when they asked to hear from us again.",
    action: "Clear opt-out",
    done: "WhatsApp opt-out cleared",
  },
  email: {
    title: "Clear email status?",
    description:
      "This address bounced or the contact unsubscribed. Clear it only when the address is fixed or they asked to hear from us again.",
    action: "Clear status",
    done: "Email status cleared",
  },
};

/**
 * Admin only (E1 rule 8, D3 rule 6): clears a WhatsApp opt-out or an email bounce / unsubscribe
 * with a required reason; the timeline records who and why.
 */
export function ClearOptOutDialog({
  contactId,
  open,
  onOpenChange,
  channel = "whatsapp",
}: {
  contactId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel?: "whatsapp" | "email";
}) {
  const { clearWhatsAppOptOut, clearEmailStatus } = useLeadMutations();
  const text = TEXT[channel];
  const form = useForm<ClearOptOutForm>({
    resolver: zodResolver(schema),
    defaultValues: { reason: "" },
  });
  const { reset } = form;
  useEffect(() => {
    if (open) reset({ reason: "" });
  }, [open, reset]);
  const errors = form.formState.errors;

  const submit = form.handleSubmit(async ({ reason }) => {
    try {
      await (channel === "email" ? clearEmailStatus : clearWhatsAppOptOut)(
        contactId,
        reason.trim(),
      );
      toast.success(text.done);
      onOpenChange(false);
    } catch (error) {
      form.setError("root", { message: messageFromError(error) });
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="clear-opt-out-reason">Reason</Label>
            <Textarea
              id="clear-opt-out-reason"
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
              {text.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
