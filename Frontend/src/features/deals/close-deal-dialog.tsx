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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { dateInputValue } from "@/lib/dates";
import { label } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { messageFromError, useMoveDealStage, useUpdateDeal } from "@/store";
import { LOSS_REASON_CHOICES, type ContactAction, type DealListItem } from "@/types";
import { CONTACT_ACTION_OPTIONS, DEAL_STAGE_LABELS, OPEN_DEAL_STAGES } from "./deal-labels";

export type CloseMode = "won" | "lost" | "reopen" | "negotiation";
type ClosableDeal = Pick<DealListItem, "id" | "name" | "stage" | "amount" | "expectedCloseDate">;

const amountField = z
  .string()
  .trim()
  .refine((v) => v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0), {
    message: "Enter an amount of 0 or more.",
  });

const wonSchema = z.object({ amount: amountField, closeDate: z.string() });
const lostSchema = z
  .object({
    lossReason: z.enum(LOSS_REASON_CHOICES, {
      errorMap: () => ({ message: "Pick a loss reason." }),
    }),
    lossNotes: z.string().trim().max(2000),
    contactAction: z.enum(["keep", "long_term_nurture", "lost"]),
    competitorName: z.string().trim().max(200),
    projectDate: z.string(),
  })
  .refine(
    (v) => !(v.contactAction === "lost" && v.lossReason === "project_postponed" && !v.projectDate),
    { message: "Pick the project date.", path: ["projectDate"] },
  );
// LL-3: a deal moved into negotiation needs its next decision date.
const decisionDate = z.string().min(1, "Pick the next decision date.");
const negotiationSchema = z.object({ nextDecisionDate: decisionDate });
const reopenSchema = z
  .object({
    stage: z.enum(OPEN_DEAL_STAGES as [string, ...string[]]),
    nextDecisionDate: z.string(),
  })
  .refine((v) => v.stage !== "negotiation" || Boolean(v.nextDecisionDate), {
    message: "Pick the next decision date.",
    path: ["nextDecisionDate"],
  });

const TITLES: Record<CloseMode, string> = {
  won: "Mark deal won",
  lost: "Mark deal lost",
  reopen: "Reopen deal",
  negotiation: "Move to negotiation",
};

/**
 * Closing a deal — one dialog for the board, the record page and the lists. Won: confirm or
 * edit the amount and close date (PATCH first when changed), then stage won. Lost: reason
 * (required), notes and what happens to the contact, in ONE POST /deals/:id/stage. Reopen:
 * pick an open stage. Business rules stay in the backend; its 400/409 show inline.
 */
export function CloseDealDialog({
  deal,
  mode,
  open,
  onOpenChange,
  onDone,
}: {
  deal: ClosableDeal | null;
  mode: CloseMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  return (
    <Dialog open={open && Boolean(deal)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{TITLES[mode]}</DialogTitle>
          <DialogDescription>{deal?.name}</DialogDescription>
        </DialogHeader>
        {deal && open && (
          <CloseForm
            key={`${deal.id}-${mode}`}
            deal={deal}
            mode={mode}
            done={() => {
              onOpenChange(false);
              onDone?.();
            }}
            cancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CloseForm({
  deal,
  mode,
  done,
  cancel,
}: {
  deal: ClosableDeal;
  mode: CloseMode;
  done: () => void;
  cancel: () => void;
}) {
  const props = { deal, done, cancel };
  if (mode === "won") return <WonForm {...props} />;
  if (mode === "lost") return <LostForm {...props} />;
  if (mode === "negotiation") return <NegotiationForm {...props} />;
  return <ReopenForm {...props} />;
}

type FormProps = { deal: ClosableDeal; done: () => void; cancel: () => void };

function Footer({
  cancel,
  submitting,
  text,
}: {
  cancel: () => void;
  submitting: boolean;
  text: string;
}) {
  return (
    <DialogFooter>
      <Button type="button" variant="ghost" onClick={cancel}>
        Cancel
      </Button>
      <Button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : text}
      </Button>
    </DialogFooter>
  );
}

const RootError = ({ message }: { message?: string | undefined }) =>
  message ? (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null;

function WonForm({ deal, done, cancel }: FormProps) {
  const update = useUpdateDeal();
  const move = useMoveDealStage();
  const initial = {
    amount: deal.amount === null ? "" : String(deal.amount),
    closeDate: deal.expectedCloseDate ?? dateInputValue(0),
  };
  const form = useForm<z.infer<typeof wonSchema>>({
    resolver: zodResolver(wonSchema),
    defaultValues: initial,
  });
  const errors = form.formState.errors;
  const submit = form.handleSubmit(async (v) => {
    try {
      const amount = v.amount === "" ? null : Number(v.amount);
      const patch = {
        ...(amount !== deal.amount ? { amount } : {}),
        ...(v.closeDate !== (deal.expectedCloseDate ?? "") && v.closeDate
          ? { expectedCloseDate: v.closeDate }
          : {}),
      };
      if (Object.keys(patch).length) await update.mutateAsync({ id: deal.id, input: patch });
      await move.mutateAsync({ id: deal.id, stage: "won" });
      toast.success("Deal won");
      done();
    } catch (error) {
      form.setError("root", { message: messageFromError(error) });
    }
  });
  return (
    <form className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="won-amount" className="mb-1.5 block text-xs">
            Amount (INR)
          </Label>
          <Input
            id="won-amount"
            inputMode="decimal"
            {...form.register("amount")}
            aria-invalid={Boolean(errors.amount)}
          />
          {errors.amount && (
            <p className="mt-1 text-xs text-destructive">{errors.amount.message}</p>
          )}
        </div>
        <div>
          <Label htmlFor="won-date" className="mb-1.5 block text-xs">
            Close date
          </Label>
          <Input id="won-date" type="date" {...form.register("closeDate")} />
        </div>
      </div>
      <p className="type-small text-muted-foreground">
        If this is the contact&rsquo;s only open deal, the contact is also marked Won.
      </p>
      <RootError message={errors.root?.message} />
      <Footer cancel={cancel} submitting={form.formState.isSubmitting} text="Mark won" />
    </form>
  );
}

function LostForm({ deal, done, cancel }: FormProps) {
  const move = useMoveDealStage();
  const form = useForm<z.infer<typeof lostSchema>>({
    resolver: zodResolver(lostSchema),
    defaultValues: {
      lossNotes: "",
      contactAction: "keep",
      competitorName: "",
      projectDate: "",
    } as z.infer<typeof lostSchema>,
  });
  const errors = form.formState.errors;
  const reason = form.watch("lossReason");
  const submit = form.handleSubmit(async (v) => {
    try {
      await move.mutateAsync({
        id: deal.id,
        stage: "lost",
        lossReason: v.lossReason,
        lossNotes: v.lossNotes || undefined,
        contactAction: v.contactAction,
        competitorName:
          v.lossReason === "competitor_selected" ? v.competitorName || undefined : undefined,
        projectDate: v.lossReason === "project_postponed" ? v.projectDate || undefined : undefined,
      });
      toast.success("Deal lost");
      done();
    } catch (error) {
      form.setError("root", { message: messageFromError(error) });
    }
  });
  return (
    <form className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
      <div>
        <Label htmlFor="lost-reason" className="mb-1.5 block text-xs">
          Loss reason
        </Label>
        <Controller
          control={form.control}
          name="lossReason"
          render={({ field }) => (
            <Select value={field.value ?? ""} onValueChange={field.onChange}>
              <SelectTrigger id="lost-reason" aria-invalid={Boolean(errors.lossReason)}>
                <SelectValue placeholder="Choose a reason" />
              </SelectTrigger>
              <SelectContent>
                {LOSS_REASON_CHOICES.map((r) => (
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
      {reason === "competitor_selected" && (
        <div>
          <Label htmlFor="lost-competitor-name" className="mb-1.5 block text-xs">
            Competitor name (optional)
          </Label>
          <Input id="lost-competitor-name" {...form.register("competitorName")} />
        </div>
      )}
      {reason === "project_postponed" && (
        <div>
          <Label htmlFor="lost-project-date" className="mb-1.5 block text-xs">
            Project date (needed when the contact is marked lost too)
          </Label>
          <Input
            id="lost-project-date"
            type="date"
            min={dateInputValue(1)}
            aria-invalid={Boolean(errors.projectDate)}
            {...form.register("projectDate")}
          />
          {errors.projectDate && (
            <p className="mt-1 text-xs text-destructive">{errors.projectDate.message}</p>
          )}
        </div>
      )}
      <div>
        <Label htmlFor="lost-notes" className="mb-1.5 block text-xs">
          Notes
        </Label>
        <Textarea id="lost-notes" rows={3} {...form.register("lossNotes")} />
      </div>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium">What happens to the contact?</legend>
        <Controller
          control={form.control}
          name="contactAction"
          render={({ field }) => (
            <div className="space-y-1.5">
              {CONTACT_ACTION_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-md border p-2.5",
                    field.value === o.value && "border-primary bg-accent",
                  )}
                >
                  <input
                    type="radio"
                    name="contactAction"
                    value={o.value}
                    checked={field.value === o.value}
                    onChange={() => field.onChange(o.value as ContactAction)}
                    className="mt-0.5 accent-primary"
                  />
                  <span>
                    <span className="block type-body font-medium">{o.label}</span>
                    <span className="block type-small text-muted-foreground">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        />
      </fieldset>
      <RootError message={errors.root?.message} />
      <Footer cancel={cancel} submitting={form.formState.isSubmitting} text="Mark lost" />
    </form>
  );
}

/** LL-3 rule 9: moving into negotiation asks for the next decision date (a passed date gives the owner a task). */
function NegotiationForm({ deal, done, cancel }: FormProps) {
  const move = useMoveDealStage();
  const form = useForm<z.infer<typeof negotiationSchema>>({
    resolver: zodResolver(negotiationSchema),
    defaultValues: { nextDecisionDate: "" },
  });
  const errors = form.formState.errors;
  const submit = form.handleSubmit(async (v) => {
    try {
      await move.mutateAsync({
        id: deal.id,
        stage: "negotiation",
        nextDecisionDate: v.nextDecisionDate,
      });
      toast.success(`Moved to ${DEAL_STAGE_LABELS.negotiation}`);
      done();
    } catch (error) {
      form.setError("root", { message: messageFromError(error) });
    }
  });
  return (
    <form className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
      <DecisionDateField
        register={form.register("nextDecisionDate")}
        error={errors.nextDecisionDate?.message}
      />
      <RootError message={errors.root?.message} />
      <Footer cancel={cancel} submitting={form.formState.isSubmitting} text="Move" />
    </form>
  );
}

function DecisionDateField({
  register,
  error,
}: {
  register: ReturnType<ReturnType<typeof useForm<{ nextDecisionDate: string }>>["register"]>;
  error?: string | undefined;
}) {
  return (
    <div>
      <Label htmlFor="next-decision-date" className="mb-1.5 block text-xs">
        Next decision date (required)
      </Label>
      <Input
        id="next-decision-date"
        type="date"
        min={dateInputValue()}
        aria-invalid={Boolean(error)}
        {...register}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      <p className="pt-1 type-small text-muted-foreground">
        When the client should decide. If the date passes with the deal still here, you get a task.
      </p>
    </div>
  );
}

function ReopenForm({ deal, done, cancel }: FormProps) {
  const move = useMoveDealStage();
  const form = useForm<z.infer<typeof reopenSchema>>({
    resolver: zodResolver(reopenSchema),
    defaultValues: { stage: "qualified", nextDecisionDate: "" },
  });
  const stage = form.watch("stage");
  const submit = form.handleSubmit(async (v) => {
    try {
      await move.mutateAsync({
        id: deal.id,
        stage: v.stage as (typeof OPEN_DEAL_STAGES)[number],
        ...(v.stage === "negotiation" ? { nextDecisionDate: v.nextDecisionDate } : {}),
      });
      toast.success("Deal reopened");
      done();
    } catch (error) {
      form.setError("root", { message: messageFromError(error) });
    }
  });
  return (
    <form className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
      <div>
        <Label htmlFor="reopen-stage" className="mb-1.5 block text-xs">
          Reopen at stage
        </Label>
        <Controller
          control={form.control}
          name="stage"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="reopen-stage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPEN_DEAL_STAGES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {DEAL_STAGE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>
      {stage === "negotiation" && (
        <DecisionDateField
          register={form.register("nextDecisionDate")}
          error={form.formState.errors.nextDecisionDate?.message}
        />
      )}
      <p className="type-small text-muted-foreground">
        Reopening doesn&rsquo;t change the contact; reactivate it from the contact if needed.
      </p>
      <RootError message={form.formState.errors.root?.message} />
      <Footer cancel={cancel} submitting={form.formState.isSubmitting} text="Reopen" />
    </form>
  );
}
