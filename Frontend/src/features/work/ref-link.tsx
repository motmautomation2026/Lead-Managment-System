import { RecordLink } from "@/features/crm/record-link";
import type { IdName } from "@/types";

/** A contact / company / deal cell link (stops the row click that opens the Sheet). */
export function RefLink({
  type,
  value,
}: {
  type: "contact" | "company" | "deal";
  value: IdName | null;
}) {
  if (!value) return <span className="text-muted-foreground">–</span>;
  return (
    <RecordLink
      type={type}
      id={value.id}
      className="truncate hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {value.name || "Unnamed"}
    </RecordLink>
  );
}
