import { useState } from "react";
import { useForm } from "react-hook-form";
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
import { HOT_BAND_LABEL, hotReasonText, type HotBand } from "./hot-score-labels";
import { RelativeTime } from "@/components/crm/relative-time";
import { StatusBadge } from "@/components/common/status-badge";
import { label } from "@/lib/labels";
import {
  SERVICE_INTERESTS,
  normalizeEmail,
  normalizePhone,
  validateLeadForm,
  type LeadFormErrors,
} from "@/lib/lead-validation";
import { messageFromError, useIsAdmin, useLeadMutations, useSession } from "@/store";
import { ClearOptOutDialog } from "./clear-opt-out-dialog";
import { MoveWhatsAppNumberDialog } from "./move-whatsapp-number-dialog";
import { LEAD_SOURCES, PIPELINE_STAGES, type ContactDetail, type Contactability } from "@/types";
import type { UpdateLeadInput } from "@/lib/backend-client";

type TextField = Extract<
  keyof UpdateLeadInput,
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "company"
  | "jobTitle"
  | "industry"
  | "revenueRange"
>;

const textValue = (contact: ContactDetail, field: TextField) =>
  (field === "company" ? contact.companyText : contact[field]) ?? "";

/** One text property: same rules as Create contact (the whole record is validated with the new value). */
export function TextEditor({
  contact,
  field,
  name,
  done,
}: {
  contact: ContactDetail;
  field: TextField;
  name: string;
  done: () => void;
}) {
  const { updateLead } = useLeadMutations();
  const form = useForm<{ value: string }>({ defaultValues: { value: textValue(contact, field) } });
  const error = form.formState.errors.value?.message;

  const save = form.handleSubmit(async ({ value }) => {
    const next = {
      firstName: contact.firstName,
      company: contact.companyText,
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      source: contact.source,
      [field]: value,
    };
    const rule = validateLeadForm(next)[field as keyof LeadFormErrors];
    if (rule) return form.setError("value", { message: rule });
    const trimmed = value.trim();
    const sent =
      field === "email" && trimmed
        ? (normalizeEmail(trimmed).value ?? trimmed)
        : field === "phone" && trimmed
          ? (normalizePhone(trimmed).value ?? trimmed)
          : trimmed;
    try {
      await updateLead(contact.id, { [field]: sent });
      toast.success(`${name} saved`);
      done();
    } catch (e) {
      form.setError("value", { message: messageFromError(e) });
    }
  });

  return (
    <form className="space-y-1.5" onSubmit={(e) => void save(e)} noValidate>
      <Input
        autoFocus
        aria-label={name}
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

/** A select property that saves on change; backend errors stay inline. */
function SelectEditor({
  name,
  value,
  options,
  onSave,
  done,
}: {
  name: string;
  value: string;
  options: { value: string; label: string }[];
  onSave: (value: string) => Promise<unknown>;
  done: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <div className="space-y-1.5">
      <Select
        value={value}
        disabled={saving}
        onValueChange={(next) => {
          setSaving(true);
          setError(null);
          onSave(next)
            .then(() => {
              toast.success(`${name} saved`);
              done();
            })
            .catch((e: unknown) => setError(messageFromError(e)))
            .finally(() => setSaving(false));
        }}
      >
        <SelectTrigger aria-label={name}>
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
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

const TEXT_FIELDS: Array<[TextField, string]> = [
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["company", "Company"],
  ["jobTitle", "Job title"],
  ["industry", "Industry"],
];

/** Left panel "About": every editable contact property, saved with PATCH /leads/:id. */
/** D3: email statuses that block sending, as the contact's status line shows them. */
const EMAIL_BLOCKED_TEXT: Record<string, string> = {
  permanent_bounce: "Bounced",
  invalid: "Invalid",
  unsubscribed: "Unsubscribed",
};

export function ContactAbout({
  contact,
  contactability,
}: {
  contact: ContactDetail;
  contactability: Contactability[];
}) {
  const { users } = useSession();
  const { updateLead } = useLeadMutations();
  const isAdmin = useIsAdmin();
  const [clearOpen, setClearOpen] = useState(false);
  const [clearChannel, setClearChannel] = useState<"whatsapp" | "email">("whatsapp");
  const [moveOpen, setMoveOpen] = useState(false);
  const text = ([field, name]: [TextField, string]): Property => ({
    id: field,
    label: name,
    value: textValue(contact, field) || null,
    editor: (done) => <TextEditor contact={contact} field={field} name={name} done={done} />,
  });
  const select = (
    id: string,
    name: string,
    value: string,
    shown: string | null,
    options: { value: string; label: string }[],
    save: (v: string) => Promise<unknown>,
  ): Property => ({
    id,
    label: name,
    value: shown,
    editor: (done) => (
      <SelectEditor name={name} value={value} options={options} onSave={save} done={done} />
    ),
  });

  const { editor: stageEditor, ...stage } = select(
    "leadStatus",
    "Lead status",
    contact.pipelineStage,
    null,
    PIPELINE_STAGES.map((s) => ({ value: s, label: label(s) })),
    (v) => updateLead(contact.id, { pipelineStage: v as ContactDetail["pipelineStage"] }),
  );
  const items: Property[] = [
    ...TEXT_FIELDS.map(text),
    select(
      "source",
      "Source",
      contact.source,
      label(contact.source),
      LEAD_SOURCES.map((s) => ({ value: s, label: label(s) })),
      (v) => updateLead(contact.id, { source: v as ContactDetail["source"] }),
    ),
    select(
      "serviceInterest",
      "Service interest",
      contact.serviceInterest,
      contact.serviceInterest || null,
      SERVICE_INTERESTS.map((s) => ({ value: s, label: s })),
      (v) => updateLead(contact.id, { serviceInterest: v }),
    ),
    text(["revenueRange", "Company revenue"]),
    select(
      "owner",
      "Owner",
      contact.ownerId ?? "",
      contact.ownerName ?? "Unassigned",
      users.filter((u) => u.active).map((u) => ({ value: u.id, label: u.name })),
      (v) => updateLead(contact.id, { ownerId: v }),
    ),
    {
      ...stage,
      value: (
        <div className="space-y-1">
          <StatusBadge value={contact.pipelineStage} />
          <p className="type-small text-muted-foreground">
            Normally set automatically by call outcomes, meetings and proposals.
          </p>
        </div>
      ),
      // Stage override as today: active contacts only.
      ...(contact.lifecycleState === "active" && stageEditor ? { editor: stageEditor } : {}),
    },
    ...contactability.map((c) => {
      // D4a: a STOP opt-out says why ("Asked to stop on WhatsApp"); D3: so do email bounces / unsubscribes.
      const emailBlocked = c.channel === "email" && c.status in EMAIL_BLOCKED_TEXT;
      const status = emailBlocked ? EMAIL_BLOCKED_TEXT[c.status]! : label(c.status);
      const text =
        (c.status === "opted_out" || emailBlocked) && c.reason ? `${status} — ${c.reason}` : status;
      const clearable = (c.channel === "whatsapp" && c.status === "opted_out") || emailBlocked;
      return {
        id: `contactability-${c.channel}`,
        label: `${label(c.channel)} status`,
        value:
          clearable && isAdmin ? (
            <div className="space-y-1">
              <p className="break-words">{text}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setClearChannel(c.channel === "email" ? "email" : "whatsapp");
                  setClearOpen(true);
                }}
              >
                {c.channel === "email" ? "Clear" : "Clear opt-out"}
              </Button>
            </div>
          ) : (
            text
          ),
      };
    }),
    {
      id: "whatsappNumber",
      label: "WhatsApp number",
      value: (
        <div className="space-y-1">
          <p>{contact.whatsappNumber?.label ?? "Set on the first WhatsApp message"}</p>
          {isAdmin && (
            <Button type="button" size="sm" variant="outline" onClick={() => setMoveOpen(true)}>
              Move to another number
            </Button>
          )}
        </div>
      ),
    },
    {
      id: "hotScore",
      label: "Hot-lead score",
      value:
        contact.hotScore == null || !contact.hotBand ? (
          "Not scored yet"
        ) : (
          <div className="space-y-1">
            <StatusBadge
              value=""
              display={`${HOT_BAND_LABEL[contact.hotBand as HotBand]} · ${contact.hotScore}`}
              tone={
                contact.hotBand === "hot"
                  ? "danger"
                  : contact.hotBand === "warm"
                    ? "warning"
                    : "muted"
              }
            />
            {contact.hotReasons?.length ? (
              <ul className="type-small list-disc pl-4 text-muted-foreground">
                {contact.hotReasons.map((code) => (
                  <li key={code}>{hotReasonText(code)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ),
    },
    { id: "createdAt", label: "Created", value: <RelativeTime value={contact.createdAt} /> },
  ];
  return (
    <>
      <PropertyList items={items} />
      {isAdmin && (
        <ClearOptOutDialog
          contactId={contact.id}
          channel={clearChannel}
          open={clearOpen}
          onOpenChange={setClearOpen}
        />
      )}
      {isAdmin && moveOpen && (
        <MoveWhatsAppNumberDialog
          contactId={contact.id}
          currentNumberId={contact.whatsappNumber?.id ?? null}
          open={moveOpen}
          onOpenChange={setMoveOpen}
        />
      )}
    </>
  );
}
