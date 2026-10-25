import { useState } from "react";
import { Link } from "@tanstack/react-router";
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
import { StatusBadge } from "@/components/common/status-badge";
import { AssociationCard } from "@/components/crm/association-card";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";
import { label } from "@/lib/labels";
import { messageFromError, useCompany, useCreateDeal } from "@/store";
import { DEAL_STAGES, type ContactDetail, type DealStage } from "@/types";
import { TextEditor } from "./contact-about";
import { defaultDealName } from "./contact-helpers";

/** Won/Lost need the deal page's close dialog (C4); a new deal starts open. */
const OPEN_STAGES = DEAL_STAGES.filter((s) => s !== "won" && s !== "lost");

const dealSchema = z.object({
  name: z.string().trim().min(1, "Give the deal a name.").max(200),
  amount: z
    .string()
    .trim()
    .refine((v) => v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0), {
      message: "Enter an amount of 0 or more.",
    }),
  expectedCloseDate: z.string(),
  stage: z.enum(DEAL_STAGES),
});
type DealForm = z.infer<typeof dealSchema>;

export function CreateDealDialog({
  contact,
  open,
  onOpenChange,
}: {
  contact: ContactDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateDeal();
  const defaults: DealForm = {
    name: defaultDealName(contact),
    amount: "",
    expectedCloseDate: "",
    stage: "qualified",
  };
  const form = useForm<DealForm>({ resolver: zodResolver(dealSchema), defaultValues: defaults });
  const errors = form.formState.errors;
  const close = (value: boolean) => {
    onOpenChange(value);
    if (!value) form.reset(defaults);
  };
  const submit = form.handleSubmit(async (v) => {
    try {
      await create.mutateAsync({
        leadId: contact.id,
        name: v.name,
        stage: v.stage,
        ...(v.amount ? { amount: Number(v.amount), currency: "INR" as const } : {}),
        ...(v.expectedCloseDate ? { expectedCloseDate: v.expectedCloseDate } : {}),
      });
      toast.success("Deal created");
      close(false);
    } catch (error) {
      form.setError("root", { message: messageFromError(error) });
    }
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create deal</DialogTitle>
          <DialogDescription>
            For {contact.firstName} {contact.lastName}. Company and owner come from the contact.
          </DialogDescription>
        </DialogHeader>
        <form id="create-deal" className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
          <div>
            <Label htmlFor="deal-name" className="mb-1.5 block text-xs">
              Deal name
            </Label>
            <Input id="deal-name" {...form.register("name")} aria-invalid={Boolean(errors.name)} />
            {errors.name && <p className="mt-1 text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="deal-amount" className="mb-1.5 block text-xs">
                Amount (INR)
              </Label>
              <Input
                id="deal-amount"
                inputMode="decimal"
                {...form.register("amount")}
                aria-invalid={Boolean(errors.amount)}
              />
              {errors.amount && (
                <p className="mt-1 text-xs text-destructive">{errors.amount.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="deal-close" className="mb-1.5 block text-xs">
                Expected close date
              </Label>
              <Input id="deal-close" type="date" {...form.register("expectedCloseDate")} />
            </div>
          </div>
          <div>
            <Label htmlFor="deal-stage" className="mb-1.5 block text-xs">
              Stage
            </Label>
            <Controller
              control={form.control}
              name="stage"
              render={({ field }) => (
                <Select value={field.value} onValueChange={(v) => field.onChange(v as DealStage)}>
                  <SelectTrigger id="deal-stage">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPEN_STAGES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {label(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          {errors.root && <p className="text-sm text-destructive">{errors.root.message}</p>}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-deal" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Creating…" : "Create deal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Right panel: the contact's company and deals. */
export function ContactAssociations({ contact }: { contact: ContactDetail }) {
  const company = useCompany(contact.company?.id);
  const [changeOpen, setChangeOpen] = useState(false);
  const [dealOpen, setDealOpen] = useState(false);
  const c = company.data;

  return (
    <>
      <AssociationCard
        title="Company"
        count={contact.company ? 1 : 0}
        addLabel="Change"
        onAdd={() => setChangeOpen(true)}
        emptyText={
          contact.companyText
            ? `“${contact.companyText}” isn't linked to a company record yet.`
            : "No company."
        }
        items={
          contact.company
            ? [
                {
                  id: contact.company.id,
                  // Plain text until the company record page lands (C3).
                  title: contact.company.name,
                  subtitle:
                    [contact.company.domain, c?.industry].filter(Boolean).join(" · ") || null,
                  meta: c ? (
                    <span className="type-small text-muted-foreground">
                      {c.contactCount} contact{c.contactCount === 1 ? "" : "s"}
                    </span>
                  ) : null,
                },
              ]
            : []
        }
      />
      <AssociationCard
        title="Deals"
        addLabel="Create deal"
        onAdd={() => setDealOpen(true)}
        emptyText="No deals yet."
        items={contact.deals.map((d) => ({
          id: d.id,
          title: (
            <Link to="/deals/$dealId" params={{ dealId: d.id }} className="hover:underline">
              {d.name}
            </Link>
          ),
          subtitle: (
            <span className="inline-flex items-center gap-2">
              <StatusBadge value={d.stage} />
              <Money amount={d.amount} currency={d.currency} compact />
            </span>
          ),
          meta: d.closedAt ? (
            <span className="type-small text-muted-foreground">
              Closed <RelativeTime value={d.closedAt} />
            </span>
          ) : (
            <span className="type-small text-muted-foreground">Open</span>
          ),
        }))}
      />

      <Dialog open={changeOpen} onOpenChange={setChangeOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Change company</DialogTitle>
            <DialogDescription>
              Edit the company name; the contact is relinked to the matching company record.
            </DialogDescription>
          </DialogHeader>
          {changeOpen && (
            <TextEditor
              contact={contact}
              field="company"
              name="Company"
              done={() => setChangeOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
      <CreateDealDialog contact={contact} open={dealOpen} onOpenChange={setDealOpen} />
    </>
  );
}
