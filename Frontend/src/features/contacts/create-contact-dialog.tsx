import type { ReactNode } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
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
import { BackendError } from "@/lib/backend-client";
import { label } from "@/lib/labels";
import {
  SERVICE_INTERESTS,
  leadFormSchema,
  normalizeEmail,
  normalizePhone,
  type LeadFormValues,
} from "@/lib/lead-validation";
import { messageFromError, useCompanySearch, useCreateContact, useSession } from "@/store";
import { LEAD_SOURCES, type LeadSource } from "@/types";

/** Owner select value meaning "send no ownerId": the workspace's assignment rules decide. */
const AUTO_OWNER = "auto";

const EMPTY: LeadFormValues = {
  firstName: "",
  lastName: "",
  company: "",
  jobTitle: "",
  industry: "",
  email: "",
  phone: "",
  source: "website",
  serviceInterest: "B2B Lead Generation",
  revenueRange: "",
  ownerId: "",
};

function fieldFromDetails(details: unknown): keyof LeadFormValues | null {
  if (details && typeof details === "object" && "field" in details) {
    const field = (details as { field?: unknown }).field;
    return typeof field === "string" && field in EMPTY ? (field as keyof LeadFormValues) : null;
  }
  return null;
}

/** "+ Create → Contact" and the Contacts page: POST /leads, then open the new record. */
export function CreateContactDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { users } = useSession();
  const create = useCreateContact();
  const form = useForm<LeadFormValues>({
    resolver: zodResolver(leadFormSchema),
    defaultValues: EMPTY,
    mode: "onTouched",
  });
  const { register, control, handleSubmit, setValue, setError, reset, formState, watch } = form;
  const errors = formState.errors;
  const company = watch("company");
  const matches = useCompanySearch(company);
  // Informational only: the backend links the company itself.
  const match = matches.data?.data.find(
    (c) => c.name.toLowerCase() === company.trim().toLowerCase(),
  );

  const close = (value: boolean) => {
    onOpenChange(value);
    if (!value) reset(EMPTY);
  };

  const submit = handleSubmit(async (values) => {
    try {
      const lead = await create.mutateAsync({
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        company: values.company.trim(),
        jobTitle: values.jobTitle.trim() || undefined,
        industry: values.industry.trim(),
        phone: values.phone.trim()
          ? (normalizePhone(values.phone).value ?? values.phone.trim())
          : "",
        email: values.email.trim()
          ? (normalizeEmail(values.email).value ?? values.email.trim())
          : "",
        source: values.source as LeadSource,
        serviceInterest: values.serviceInterest,
        revenueRange: values.revenueRange.trim() || undefined,
        ownerId: values.ownerId || undefined,
      });
      toast.success("Contact created");
      close(false);
      void navigate({ to: "/contacts/$contactId", params: { contactId: lead.id } });
    } catch (error) {
      // Nothing was created: keep the form so the user can fix and retry.
      const field = error instanceof BackendError ? fieldFromDetails(error.details) : null;
      if (field) setError(field, { message: messageFromError(error) });
      else toast.error(messageFromError(error));
    }
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create contact</DialogTitle>
          <DialogDescription>
            New contacts start in the New stage with a first call as the next action.
          </DialogDescription>
        </DialogHeader>
        <form id="create-contact" onSubmit={(e) => void submit(e)} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="cc-first" label="First name" error={errors.firstName?.message}>
              <Input
                id="cc-first"
                {...register("firstName")}
                aria-invalid={Boolean(errors.firstName)}
              />
            </Field>
            <Field id="cc-last" label="Last name">
              <Input id="cc-last" {...register("lastName")} />
            </Field>
            <Field id="cc-email" label="Email" error={errors.email?.message}>
              <Input
                id="cc-email"
                type="email"
                {...register("email", {
                  onBlur: (e: { target: { value: string } }) => {
                    const { value } = normalizeEmail(e.target.value);
                    if (value) setValue("email", value, { shouldValidate: true });
                  },
                })}
                aria-invalid={Boolean(errors.email)}
              />
            </Field>
            <Field id="cc-phone" label="Phone" error={errors.phone?.message}>
              <Input
                id="cc-phone"
                placeholder="+91 …"
                {...register("phone", {
                  onBlur: (e: { target: { value: string } }) => {
                    const { value } = normalizePhone(e.target.value);
                    if (value) setValue("phone", value, { shouldValidate: true });
                  },
                })}
                aria-invalid={Boolean(errors.phone)}
              />
            </Field>
            <Field
              id="cc-company"
              label="Company"
              className="sm:col-span-2"
              error={errors.company?.message}
              hint={match ? `Matches the existing company “${match.name}”.` : undefined}
            >
              <Input
                id="cc-company"
                {...register("company")}
                aria-invalid={Boolean(errors.company)}
              />
            </Field>
            <Field id="cc-title" label="Job title">
              <Input id="cc-title" {...register("jobTitle")} />
            </Field>
            <Field id="cc-industry" label="Industry">
              <Input id="cc-industry" {...register("industry")} />
            </Field>
            <Field id="cc-source" label="Lead source" error={errors.source?.message}>
              <Controller
                control={control}
                name="source"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="cc-source">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LEAD_SOURCES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {label(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field id="cc-service" label="Service interest">
              <Controller
                control={control}
                name="serviceInterest"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="cc-service">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SERVICE_INTERESTS.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field id="cc-revenue" label="Company revenue">
              <Input id="cc-revenue" placeholder="e.g. ₹1–5 Cr" {...register("revenueRange")} />
            </Field>
            <Field id="cc-owner" label="Owner">
              <Controller
                control={control}
                name="ownerId"
                render={({ field }) => (
                  <Select
                    value={field.value || AUTO_OWNER}
                    onValueChange={(v) => field.onChange(v === AUTO_OWNER ? "" : v)}
                  >
                    <SelectTrigger id="cc-owner">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AUTO_OWNER}>Auto (by assignment rules)</SelectItem>
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
            </Field>
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-contact" disabled={formState.isSubmitting}>
            {formState.isSubmitting ? "Creating…" : "Create contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label: text,
  children,
  className,
  error,
  hint,
}: {
  id: string;
  label: string;
  children: ReactNode;
  className?: string;
  error?: string | undefined;
  hint?: string | undefined;
}) {
  return (
    <div className={className}>
      <Label htmlFor={id} className="mb-1.5 block text-xs">
        {text}
      </Label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-destructive">{error}</p>
      ) : (
        hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
