import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Centered "nothing here" block with a clear next action. */
export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  text?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-4 py-12 text-center",
        className,
      )}
    >
      {Icon && (
        <div className="mb-1 grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <p className="type-section-title">{title}</p>
      {text && <p className="max-w-sm type-body text-muted-foreground">{text}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
