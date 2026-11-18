import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { PropertyList, type Property } from "@/components/crm/property-list";
import { RelativeTime } from "@/components/crm/relative-time";
import { messageFromError, useSession, useUpdateCompany } from "@/store";
import type { CompanyDetail } from "@/types";
import {
  COMPANY_FIELD_LABELS,
  NO_OWNER,
  companyFormSchema,
  type CompanyTextField,
} from "./company-helpers";

const ABOUT_FIELDS: CompanyTextField[] = [
  "name",
  "domain",
  "website",
  "industry",
  "employeeRange",
  "revenueRange",
  "city",
  "state",
  "country",
  "linkedinUrl",
  "description",
];

const external = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

/**
 * One text property, validated like Create company, saved with PATCH /companies/:id
 * ("" clears). A rename of a company with contacts asks first: the backend also renames
 * their company text. Backend errors (409 on a duplicate name/domain) stay inline.
 */
function CompanyTextEditor({
  company,
  field,
  done,
}: {
  company: CompanyDetail;
  field: CompanyTextField;
  done: () => void;
}) {
  const update = useUpdateCompany();
  const [pendingName, setPendingName] = useState<string | null>(null);
  const name = COMPANY_FIELD_LABELS[field];
  const form = useForm<{ value: string }>({
    defaultValues: { value: company[field] ?? "" },
  });
  const error = form.formState.errors.value?.message;

  const save = async (value: string) => {
    try {
      await update.mutateAsync({ id: company.id, input: { [field]: value.trim() || null } });
      toast.success(`${name} saved`);
      done();
    } catch (e) {
      form.setError("value", { message: messageFromError(e) });
    }
  };
  const submit = form.handleSubmit(async ({ value }) => {
    const parsed = companyFormSchema.shape[field].safeParse(value);
    if (!parsed.success)
      return form.setError("value", { message: parsed.error.issues[0]?.message ?? "Invalid." });
    if (field === "name" && value.trim() !== company.name && company.contactCount > 0)
      return setPendingName(value);
    await save(value);
  });

  const inputProps = {
    autoFocus: true,
    "aria-label": name,
    "aria-invalid": Boolean(error),
    ...form.register("value"),
    onKeyDown: (e: React.KeyboardEvent) => e.key === "Escape" && done(),
  };
  return (
    <form className="space-y-1.5" onSubmit={(e) => void submit(e)} noValidate>
      {field === "description" ? <Textarea rows={4} {...inputProps} /> : <Input {...inputProps} />}
      {error && <p className="type-small text-destructive">{error}</p>}
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" disabled={form.formState.isSubmitting || update.isPending}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={done}>
          Cancel
        </Button>
      </div>
      <ConfirmDialog
        open={pendingName !== null}
        onOpenChange={(open) => !open && setPendingName(null)}
        title={`Rename to "${pendingName?.trim() ?? ""}"?`}
        description={`This also updates the company name on ${company.contactCount} contact${company.contactCount === 1 ? "" : "s"}.`}
        confirmLabel="Rename"
        confirmVariant="default"
        disabled={update.isPending}
        onConfirm={() => {
          const value = pendingName ?? "";
          setPendingName(null);
          void save(value);
        }}
      />
    </form>
  );
}

function OwnerEditor({ company, done }: { company: CompanyDetail; done: () => void }) {
  const { users } = useSession();
  const update = useUpdateCompany();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1.5">
      <Select
        value={company.owner?.id ?? NO_OWNER}
        disabled={update.isPending}
        onValueChange={(v) => {
          setError(null);
          update
            .mutateAsync({ id: company.id, input: { ownerId: v === NO_OWNER ? null : v } })
            .then(() => {
              toast.success("Owner saved");
              done();
            })
            .catch((e: unknown) => setError(messageFromError(e)));
        }}
      >
        <SelectTrigger aria-label="Owner">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_OWNER}>No owner</SelectItem>
          {users
            .filter((u) => u.active || u.id === company.owner?.id)
            .map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {error && <p className="type-small text-destructive">{error}</p>}
      <Button type="button" size="sm" variant="ghost" onClick={done}>
        Cancel
      </Button>
    </div>
  );
}

/** Left panel "About": every editable company property (PATCH /companies/:id). */
export function CompanyAbout({ company }: { company: CompanyDetail }) {
  const show = (field: CompanyTextField) => {
    const value = company[field];
    if (!value) return null;
    if (field === "website" || field === "linkedinUrl")
      return (
        <a
          href={external(value)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {value}
        </a>
      );
    return field === "description" ? <span className="whitespace-pre-wrap">{value}</span> : value;
  };
  const items: Property[] = [
    ...ABOUT_FIELDS.map((field) => ({
      id: field,
      label: COMPANY_FIELD_LABELS[field],
      value: show(field),
      editor: (done: () => void) => (
        <CompanyTextEditor company={company} field={field} done={done} />
      ),
    })),
    {
      id: "owner",
      label: "Owner",
      value: company.owner?.name ?? "No owner",
      editor: (done) => <OwnerEditor company={company} done={done} />,
    },
    {
      id: "createdAt",
      label: "Created",
      value: (
        <span>
          <RelativeTime value={company.createdAt} />
          {company.createdBy && (
            <span className="text-muted-foreground"> · by {company.createdBy}</span>
          )}
        </span>
      ),
    },
  ];
  return <PropertyList items={items} />;
}
