import { useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface Property {
  id: string;
  label: string;
  value: ReactNode;
  /** Inline editor; call `done` to return to the read view. Omit for read-only rows. */
  editor?: (done: () => void) => ReactNode;
}

/** Label/value rows (record "About" panel); one row is edited inline at a time. */
export function PropertyList({ items }: { items: Property[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <dl className="divide-y">
      {items.map((item) => (
        <div key={item.id} className="group grid gap-1 py-2.5">
          <dt className="type-label">{item.label}</dt>
          <dd className="flex min-w-0 items-start gap-2 type-body">
            {editing === item.id && item.editor ? (
              <div className="min-w-0 flex-1">{item.editor(() => setEditing(null))}</div>
            ) : (
              <>
                <div className="min-w-0 flex-1 break-words">
                  {item.value ?? <span className="text-muted-foreground">–</span>}
                </div>
                {item.editor && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 opacity-60 group-hover:opacity-100"
                    aria-label={`Edit ${item.label}`}
                    onClick={() => setEditing(item.id)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                )}
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
