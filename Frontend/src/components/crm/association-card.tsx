import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export interface AssociationItem {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Usually a router <Link> or <a> wrapping `title`; rendered as given. */
  meta?: ReactNode;
}

/** Linked records on a record page (company's contacts, contact's deals…). */
export function AssociationCard({
  title,
  count,
  items,
  onAdd,
  addLabel = "Add",
  emptyText = "None yet.",
}: {
  title: string;
  count?: number;
  items: AssociationItem[];
  onAdd?: () => void;
  addLabel?: string;
  emptyText?: string;
}) {
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="type-section-title">
          {title}
          <span className="ml-1.5 num font-normal text-muted-foreground">
            ({count ?? items.length})
          </span>
        </h3>
        {onAdd && (
          <Button variant="ghost" size="sm" onClick={onAdd} aria-label={`${addLabel} ${title}`}>
            <Plus /> {addLabel}
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="type-body text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="truncate type-body font-medium">{item.title}</div>
                {item.subtitle && (
                  <div className="truncate type-small text-muted-foreground">{item.subtitle}</div>
                )}
              </div>
              {item.meta && <div className="shrink-0">{item.meta}</div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
