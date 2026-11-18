import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContactPicker } from "@/features/contacts/contact-picker";
import { useContact, useDeal } from "@/store";

/** Contact filter for the work lists: ContactPicker plus a clear button; the URL holds the id. */
export function ContactFilter({
  contactId,
  onChange,
}: {
  contactId: string | undefined;
  onChange: (id: string | undefined) => void;
}) {
  const contact = useContact(contactId ?? "");
  const name = contact.data ? `${contact.data.firstName} ${contact.data.lastName}`.trim() : "…";
  return (
    <div className="flex w-full items-center gap-1 sm:w-48">
      <ContactPicker
        label="Contact filter"
        placeholder="Contact"
        value={contactId ? { id: contactId, name } : null}
        onChange={(c) => onChange(c?.id)}
      />
      {contactId && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Clear contact filter"
          onClick={() => onChange(undefined)}
        >
          <X />
        </Button>
      )}
    </div>
  );
}

/** Deal filter chip: set from a deal record's "View all" link (there is no deal picker yet). */
export function DealFilterChip({
  dealId,
  onClear,
  label = "Deal",
}: {
  dealId: string | undefined;
  onClear: () => void;
  /** Tasks have no deal link: their chip says "Tasks of this deal's contact". */
  label?: string;
}) {
  const deal = useDeal(dealId);
  if (!dealId) return null;
  return (
    <span className="inline-flex h-8 items-center gap-1 rounded-md border bg-accent pl-2.5 text-sm text-accent-foreground">
      {label}: {deal.data?.name ?? "…"}
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Clear deal filter"
        onClick={onClear}
      >
        <X />
      </Button>
    </span>
  );
}
