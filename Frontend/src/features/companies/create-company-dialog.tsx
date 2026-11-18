import { useState, type ReactNode } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate } from "@tanstack/react-router";
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
import { BackendError } from "@/lib/backend-client";
import { messageFromError, useCreateCompany, useSession } from "@/store";
import {
  COMPANY_FIELD_LABELS,
  companyFormSchema,
  existingCompanyId,
  NO_OWNER,
  type CompanyFormValues,
  type CompanyTextField,
} from "./company-helpers";

const EMPTY: CompanyFormValues = {
  name: "",
  domain: "",
  website: "",
  industry: "",
  city: "",
  state: "",
  country: "",
  linkedinUrl: "",
  employeeRange: "",
  revenueRange: "",
  description: "",
  ownerId: "",
};

const GRID_FIELDS: CompanyTextField[] = [
  "domain",
  "website",
  "industry",
  "employeeRange",
  "city",
  "state",
  "country",
  "revenueRange",
  "linkedinUrl",
];

/** "+ Create → Company" and the Companies page: POST /companies, then open the new record. */
export function CreateCompanyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { users, currentUser } = useSession();
  const create = useCreateCompany();
  const [existing, setExisting] = useState<{ id: string; message: string } | null>(null);
  const form = useForm<CompanyFormValues>({
    resolver: zodResolver(companyFormSchema),
    defaultValues: EMPTY,
    mode: "onTouched",
  });
  const { register, control, handleSubmit, setError, reset, formState } = form;
  const errors = formState.errors;

  const close = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      reset(EMPTY);
      setExisting(null);
    }
  };

  const submit = handleSubmit(async (values) => {
    setExisting(null);
    const optional = (v: string) => v.trim() || undefined;
    try {
      const company = await create.mutateAsync({
        name: values.name.trim(),
        domain: optional(values.domain),
        website: optional(values.website),
        industry: optional(values.industry),
        city: optional(values.city),
        state: optional(values.state),
        country: optional(values.country),
        linkedinUrl: optional(values.linkedinUrl),
        employeeRange: optional(values.employeeRange),
        revenueRange: optional(values.revenueRange),
        description: optional(values.description),
        // Empty = the API default (the caller).
        ...(values.ownerId ? { ownerId: values.ownerId === NO_OWNER ? null : values.ownerId } : {}),
      });
      toast.success(`Company "${company.name}" created`);
      close(false);
      void navigate({ to: "/companies/$companyId", params: { companyId: company.id } });
    } catch (error) {
      const id = existingCompanyId(error);
      if (id) return setExisting({ id, message: messageFromError(error) });
      const field =
        error instanceof BackendError
          ? (error.details as { field?: string } | undefined)?.field
          : undefined;
      if (field && field in EMPTY)
        setError(field as keyof CompanyFormValues, { message: messageFromError(error) });
      else toast.error(messageFromError(error));
    }
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create company</DialogTitle>
          <DialogDescription>
            Contacts with the same company name or email domain are linked to it automatically.
          </DialogDescription>
        </DialogHeader>
        {existing && (
          <div
            role="alert"
            className="rounded-md bg-warning-soft p-3 type-body text-warning-soft-foreground"
          >
            <p className="font-medium">This company already exists.</p>
            <p className="type-small">{existing.message}</p>
            <Link
              to="/companies/$companyId"
              params={{ companyId: existing.id }}
              onClick={() => close(false)}
              className="type-small font-medium underline"
            >
              Open the existing company
            </Link>
          </div>
        )}
        <form id="create-company" onSubmit={(e) => void submit(e)} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="co-name" label="Name" className="sm:col-span-2" error={errors.name?.message}>
              <Input id="co-name" {...register("name")} aria-invalid={Boolean(errors.name)} />
            </Field>
            {GRID_FIELDS.map((key) => (
              <Field
                key={key}
                id={`co-${key}`}
                label={COMPANY_FIELD_LABELS[key]}
                className={key === "linkedinUrl" ? "sm:col-span-2" : undefined}
                error={errors[key]?.message}
              >
                <Input
                  id={`co-${key}`}
                  placeholder={PLACEHOLDERS[key]}
                  {...register(key)}
                  aria-invalid={Boolean(errors[key])}
                />
              </Field>
            ))}
            <Field id="co-owner" label="Owner">
              <Controller
                control={control}
                name="ownerId"
                render={({ field }) => (
                  <Select
                    value={field.value || currentUser?.id || NO_OWNER}
                    onValueChange={field.onChange}
                  >
                    <SelectTrigger id="co-owner">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_OWNER}>No owner</SelectItem>
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
            <Field
              id="co-description"
              label="Description"
              className="sm:col-span-2"
              error={errors.description?.message}
            >
              <Textarea id="co-description" rows={3} {...register("description")} />
            </Field>
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-company" disabled={formState.isSubmitting}>
            {formState.isSubmitting ? "Creating…" : "Create company"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PLACEHOLDERS: Partial<Record<CompanyTextField, string>> = {
  domain: "example.com",
  website: "https://example.com",
  employeeRange: "e.g. 51–200",
  revenueRange: "e.g. ₹10–50 Cr",
  linkedinUrl: "https://www.linkedin.com/company/…",
};

function Field({
  id,
  label: text,
  children,
  className,
  error,
}: {
  id: string;
  label: string;
  children: ReactNode;
  className?: string | undefined;
  error?: string | undefined;
}) {
  return (
    <div className={className}>
      <Label htmlFor={id} className="mb-1.5 block text-xs">
        {text}
      </Label>
      {children}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
