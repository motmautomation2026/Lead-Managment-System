import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PropertyList, type Property } from "@/components/crm/property-list";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";
import { CompanyPicker } from "@/features/companies/company-picker";
import { messageFromError, useSession, useUpdateDeal } from "@/store";
import type { DealDetail, IdName, UpdateDealInput } from "@/types";
import { closeDate } from "./deal-columns";

export const NO_OWNER = "__none";

type TextField = "name" | "amount" | "expectedCloseDate";

/** Same limits as the API (PATCH /deals/:id); "" clears amount and close date. */
const FIELD: Record<TextField, { label: string; schema: z.ZodType<string>; type?: string }> = {
  name: {
    label: "Deal name",
    schema: z
      .string()
      .trim()
      .min(1, "Give the deal a name.")
      .max(300, "Keep it under 300 characters."),
  },
  amount: {
    label: "Amount (INR)",
    schema: z
      .string()
      .trim()
      .refine((v) => v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0), {
        message: "Enter an amount of 0 or more.",
      }),
  },
  expectedCloseDate: { label: "Expected close date", schema: z.string(), type: "date" },
};

const toInput = (field: TextField, value: string): UpdateDealInput =>
  field === "name"
    ? { name: value.trim() }
    : field === "amount"
      ? { amount: value.trim() === "" ? null : Number(value) }
      : { expectedCloseDate: value || null };

function DealFieldEditor({
  deal,
  field,
  done,
}: {
  deal: DealDetail;
  field: TextField;
  done: () => void;
}) {
  const update = useUpdateDeal();
  const { label, schema, type } = FIELD[field];
  const current = deal[field];
  const form = useForm<{ value: string }>({
    resolver: zodResolver(z.object({ value: schema })),
    defaultValues: { value: current === null ? "" : String(current) },
  });
  const error = form.formState.errors.value?.message;
  const submit = form.handleSubmit(async ({ value }) => {
    try {
      await update.mutateAsync({ id: deal.id, input: toInput(field, value) });
      toast.success(`${label} saved`);
      done();
    } catch (e) {
      form.setError("value", { message: messageFromError(e) });
    }
  });
  return (
    <form className="space-y-1.5" onSubmit={(e) => void submit(e)} noValidate>
      <Input
        autoFocus
        type={type ?? "text"}
        inputMode={field === "amount" ? "decimal" : undefined}
        aria-label={label}
        aria-invalid={Boolean(error)}
        {...form.register("value")}
        onKeyDown={(e) => e.key === "Escape" && done()}
      />
      {error && <p className="type-small text-destructive">{error}</p>}
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={done}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Owner select used in the header and in About (saves on change). */
export function DealOwnerSelect({
  deal,
  onSaved,
  className,
}: {
  deal: DealDetail;
  onSaved?: () => void;
  className?: string;
}) {
  const { users } = useSession();
  const update = useUpdateDeal();
  return (
    <Select
      value={deal.owner?.id ?? NO_OWNER}
      disabled={update.isPending}
      onValueChange={(v) =>
        void update
          .mutateAsync({ id: deal.id, input: { ownerId: v === NO_OWNER ? null : v } })
          .then(() => {
            toast.success("Owner saved");
            onSaved?.();
          })
          .catch((e: unknown) => toast.error(messageFromError(e)))
      }
    >
      <SelectTrigger aria-label="Deal owner" className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_OWNER}>No owner</SelectItem>
        {users
          .filter((u) => u.active || u.id === deal.owner?.id)
          .map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

function CompanyEditor({ deal, done }: { deal: DealDetail; done: () => void }) {
  const update = useUpdateDeal();
  const [error, setError] = useState<string | null>(null);
  const save = (company: IdName | null) =>
    void update
      .mutateAsync({ id: deal.id, input: { companyId: company?.id ?? null } })
      .then(() => {
        toast.success("Company saved");
        done();
      })
      .catch((e: unknown) => setError(messageFromError(e)));
  return (
    <div className="space-y-1.5">
      <CompanyPicker value={deal.company} onChange={save} label="Deal company" />
      {error && <p className="type-small text-destructive">{error}</p>}
      <div className="flex gap-1.5">
        {deal.company && (
          <Button type="button" size="sm" variant="outline" onClick={() => save(null)}>
            Remove company
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={done}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Left panel "About": editable deal fields (PATCH /deals/:id) and read-only facts. */
export function DealAbout({ deal }: { deal: DealDetail }) {
  const text = (field: TextField) => (done: () => void) => (
    <DealFieldEditor deal={deal} field={field} done={done} />
  );
  const items: Property[] = [
    { id: "name", label: "Deal name", value: deal.name, editor: text("name") },
    {
      id: "amount",
      label: "Amount",
      value: deal.amount === null ? null : <Money amount={deal.amount} currency={deal.currency} />,
      editor: text("amount"),
    },
    {
      id: "expectedCloseDate",
      label: "Expected close date",
      value: closeDate(deal.expectedCloseDate),
      editor: text("expectedCloseDate"),
    },
    {
      id: "owner",
      label: "Owner",
      value: deal.owner?.name ?? "No owner",
      editor: (done) => (
        <div className="space-y-1.5">
          <DealOwnerSelect deal={deal} onSaved={done} />
          <Button type="button" size="sm" variant="ghost" onClick={done}>
            Cancel
          </Button>
        </div>
      ),
    },
    {
      id: "company",
      label: "Company",
      value: deal.company?.name ?? null,
      editor: (done) => <CompanyEditor deal={deal} done={done} />,
    },
    { id: "currency", label: "Currency", value: deal.currency },
    { id: "source", label: "Source", value: <span className="capitalize">{deal.source}</span> },
    {
      id: "createdAt",
      label: "Created",
      value: (
        <span>
          <RelativeTime value={deal.createdAt} />
          {deal.createdBy && <span className="text-muted-foreground"> · by {deal.createdBy}</span>}
        </span>
      ),
    },
    {
      id: "closedAt",
      label: "Closed",
      value: deal.closedAt ? <RelativeTime value={deal.closedAt} /> : null,
    },
  ];
  return <PropertyList items={items} />;
}
