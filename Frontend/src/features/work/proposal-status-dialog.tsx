import { Controller, useForm } from "react-hook-form";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { label } from "@/lib/labels";
import { messageFromError, useSetProposalStatus } from "@/store";
import { LEAD_LOSS_REASONS, PROPOSAL_STATUSES, type ProposalStatus } from "@/types";

/** `lossReasonStatuses` comes from the row (backend domain); the status endpoint still enforces it. */
const statusSchema = (lossReasonStatuses: readonly ProposalStatus[]) =>
  z
    .object({
      status: z.enum(PROPOSAL_STATUSES).nullable(),
      lossReason: z.enum(LEAD_LOSS_REASONS).nullable(),
      lossNotes: z.string().max(2000),
    })
    .superRefine((v, ctx) => {
      if (!v.status) ctx.addIssue({ code: "custom", path: ["status"], message: "Pick a status." });
      else if (lossReasonStatuses.includes(v.status) && !v.lossReason)
        ctx.addIssue({ code: "custom", path: ["lossReason"], message: "Pick a loss reason." });
    });
type StatusForm = z.infer<ReturnType<typeof statusSchema>>;

export interface ProposalStatusTarget {
  id: string;
  title: string;
  status: ProposalStatus;
  /** From the list row (backend domain); the dialog offers nothing else (B4). */
  allowedNextStatuses: ProposalStatus[];
  /** From the list row: which of those statuses ask for a loss reason (C6b). */
  lossReasonStatuses: ProposalStatus[];
}

/** Change a proposal's status: only the row's `allowedNextStatuses`; the row's `lossReasonStatuses` ask for a reason (B4). */
export function ProposalStatusDialog({
  proposal,
  open,
  onOpenChange,
}: {
  proposal: ProposalStatusTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setStatus = useSetProposalStatus();
  const lossReasonStatuses = proposal?.lossReasonStatuses ?? [];
  const form = useForm<StatusForm>({
    // The dialog is keyed per proposal, so the schema is fixed for its lifetime.
    resolver: zodResolver(statusSchema(lossReasonStatuses)),
    defaultValues: { status: null, lossReason: null, lossNotes: "" },
  });
  const errors = form.formState.errors;
  const status = form.watch("status");
  const needsReason = Boolean(status && lossReasonStatuses.includes(status));
  const allowed = proposal?.allowedNextStatuses ?? [];

  const submit = form.handleSubmit(async (v) => {
    if (!proposal || !v.status) return;
    try {
      await setStatus.mutateAsync({
        id: proposal.id,
        status: v.status,
        ...(needsReason
          ? { lossReason: v.lossReason ?? undefined, lossNotes: v.lossNotes.trim() || undefined }
          : {}),
      });
    } catch (error) {
      form.setError("root", { message: messageFromError(error) });
      return;
    }
    toast.success(`Proposal marked ${label(v.status)}`);
    onOpenChange(false);
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) form.reset();
        onOpenChange(value);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change proposal status</DialogTitle>
          <DialogDescription>
            {proposal ? `${proposal.title} · now ${label(proposal.status)}` : ""}
          </DialogDescription>
        </DialogHeader>
        {allowed.length === 0 ? (
          <p className="type-body text-muted-foreground">
            {proposal ? `${label(proposal.status)} is a final status. ` : ""}Create a new proposal
            instead.
          </p>
        ) : (
          <form
            id="proposal-status"
            className="space-y-3"
            onSubmit={(e) => void submit(e)}
            noValidate
          >
            <div>
              <Label htmlFor="proposal-next-status" className="mb-1.5 block text-xs">
                New status
              </Label>
              <Controller
                control={form.control}
                name="status"
                render={({ field }) => (
                  <Select value={field.value ?? ""} onValueChange={field.onChange}>
                    <SelectTrigger id="proposal-next-status" aria-invalid={Boolean(errors.status)}>
                      <SelectValue placeholder="Choose a status" />
                    </SelectTrigger>
                    <SelectContent>
                      {allowed.map((s) => (
                        <SelectItem key={s} value={s}>
                          {label(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.status && (
                <p className="mt-1 text-xs text-destructive">{errors.status.message}</p>
              )}
            </div>
            {needsReason && (
              <>
                <div>
                  <Label htmlFor="proposal-loss-reason" className="mb-1.5 block text-xs">
                    Loss reason
                  </Label>
                  <Controller
                    control={form.control}
                    name="lossReason"
                    render={({ field }) => (
                      <Select value={field.value ?? ""} onValueChange={field.onChange}>
                        <SelectTrigger
                          id="proposal-loss-reason"
                          aria-invalid={Boolean(errors.lossReason)}
                        >
                          <SelectValue placeholder="Choose a reason" />
                        </SelectTrigger>
                        <SelectContent>
                          {LEAD_LOSS_REASONS.map((r) => (
                            <SelectItem key={r} value={r}>
                              {label(r)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {errors.lossReason && (
                    <p className="mt-1 text-xs text-destructive">{errors.lossReason.message}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="proposal-loss-notes" className="mb-1.5 block text-xs">
                    Notes
                  </Label>
                  <Textarea id="proposal-loss-notes" rows={3} {...form.register("lossNotes")} />
                </div>
              </>
            )}
            {errors.root && (
              <p role="alert" className="text-sm text-destructive">
                {errors.root.message}
              </p>
            )}
          </form>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {allowed.length === 0 ? "Close" : "Cancel"}
          </Button>
          {allowed.length > 0 && (
            <Button type="submit" form="proposal-status" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? "Saving…" : "Save status"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
