import { useNavigate } from "@tanstack/react-router";
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
import type { CreateDealOptions } from "@/app/add-lead-context";
import { ContactPicker } from "@/features/contacts/contact-picker";
import { defaultDealName } from "@/features/contacts/contact-helpers";
import { messageFromError, useContact, useCreateDeal, useSession, useUpdateDeal } from "@/store";
import { DEAL_STAGES } from "@/types";
import { DEAL_STAGE_LABELS, OPEN_DEAL_STAGES } from "./deal-labels";

const CONTACT_OWNER = "__contact";

const dealSchema = z.object({
  contact: z.object({ id: z.string(), name: z.string() }).nullable().refine(Boolean, {
    message: "Choose the contact this deal is with.",
  }),
  name: z.string().trim().max(300, "Keep the name under 300 characters."),
  stage: z.enum(DEAL_STAGES),
  amount: z
    .string()
    .trim()
    .refine((v) => v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0), {
      message: "Enter an amount of 0 or more.",
    }),
  expectedCloseDate: z.string(),
  ownerId: z.string(),
});
type DealForm = z.infer<typeof dealSchema>;

/**
 * Create deal (POST /deals), app-wide. `contact` fixes the contact (contact page); `companyId`
 * limits the picker to that company's contacts (company page). An empty name = the backend's
 * default; owner defaults to the contact's owner (another owner is set with a PATCH right after).
 * On success it opens the new deal, or with `stay` shows a toast with a link instead.
 * The host remounts it (`key`) per opening, so every opening starts from its own options.
 */
export function CreateDealDialog({
  open,
  onOpenChange,
  options = {},
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options?: CreateDealOptions;
}) {
  const navigate = useNavigate();
  const create = useCreateDeal();
  const update = useUpdateDeal();
  const { users } = useSession();
  const defaults: DealForm = {
    contact: options.contact ?? null,
    name: "",
    stage: "qualified",
    amount: "",
    expectedCloseDate: "",
    ownerId: CONTACT_OWNER,
  };
  const form = useForm<DealForm>({ resolver: zodResolver(dealSchema), defaultValues: defaults });
  const errors = form.formState.errors;
  const contact = form.watch("contact");
  const detail = useContact(contact?.id ?? "");
  const namePlaceholder = detail.data
    ? defaultDealName(detail.data)
    : "<Company> – <service interest>";

  const submit = form.handleSubmit(async (v) => {
    let dealId: string;
    try {
      const deal = await create.mutateAsync({
        leadId: v.contact!.id,
        name: v.name.trim() || undefined,
        stage: v.stage,
        ...(v.amount ? { amount: Number(v.amount), currency: "INR" as const } : {}),
        ...(v.expectedCloseDate ? { expectedCloseDate: v.expectedCloseDate } : {}),
      });
      dealId = deal.id;
    } catch (error) {
      form.setError("root", { message: messageFromError(error) });
      return;
    }
    if (v.ownerId !== CONTACT_OWNER) {
      await update
        .mutateAsync({ id: dealId, input: { ownerId: v.ownerId } })
        .catch((error: unknown) =>
          toast.error(`Deal created, but the owner wasn't changed: ${messageFromError(error)}`),
        );
    }
    onOpenChange(false);
    const openDeal = () => void navigate({ to: "/deals/$dealId", params: { dealId } });
    if (options.stay)
      toast.success("Deal created", { action: { label: "Open", onClick: openDeal } });
    else openDeal();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create deal</DialogTitle>
          <DialogDescription>
            A deal is one opportunity with one contact. Its company comes from the contact.
          </DialogDescription>
        </DialogHeader>
        <form id="create-deal" className="space-y-3" onSubmit={(e) => void submit(e)} noValidate>
          <div>
            <Label htmlFor="deal-contact" className="mb-1.5 block text-xs">
              Contact
            </Label>
            {options.contact ? (
              <p id="deal-contact" className="type-body font-medium">
                {options.contact.name}
              </p>
            ) : (
              <Controller
                control={form.control}
                name="contact"
                render={({ field }) => (
                  <ContactPicker
                    id="deal-contact"
                    value={field.value}
                    onChange={field.onChange}
                    companyId={options.companyId}
                    invalid={Boolean(errors.contact)}
                  />
                )}
              />
            )}
            {errors.contact && (
              <p className="mt-1 text-xs text-destructive">{errors.contact.message}</p>
            )}
          </div>
          <div>
            <Label htmlFor="deal-name" className="mb-1.5 block text-xs">
              Deal name
            </Label>
            <Input
              id="deal-name"
              placeholder={namePlaceholder}
              {...form.register("name")}
              aria-invalid={Boolean(errors.name)}
            />
            <p className="mt-1 text-xs text-muted-foreground">Leave empty for the default name.</p>
            {errors.name && <p className="mt-1 text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="deal-stage" className="mb-1.5 block text-xs">
                Stage
              </Label>
              <Controller
                control={form.control}
                name="stage"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="deal-stage">
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
            <div>
              <Label htmlFor="deal-owner" className="mb-1.5 block text-xs">
                Owner
              </Label>
              <Controller
                control={form.control}
                name="ownerId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="deal-owner">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={CONTACT_OWNER}>Contact&rsquo;s owner</SelectItem>
                      {users
                        .filter((u) => u.active)
                        .map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
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
          {errors.root && <p className="text-sm text-destructive">{errors.root.message}</p>}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
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
