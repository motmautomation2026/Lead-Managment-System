import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusPill, type PillTone } from "./status-pill";

const BORDER: Record<PillTone, string> = {
  neutral: "",
  primary: "",
  info: "",
  success: "",
  warning: "border-warning/50",
  danger: "border-destructive/40",
};

/**
 * The one-glance summary at the top of a channel / record section: what it is, its status
 * (connected / paused / needs attention), the one key number, and the one next action.
 */
export function StatusCard({
  title,
  icon: Icon,
  tone,
  status,
  detail,
  metric,
  action,
  className,
}: {
  title: string;
  icon?: LucideIcon;
  tone: PillTone;
  status: string;
  detail?: ReactNode;
  metric?: { label: string; value: ReactNode };
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={`${title} status`}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center",
        BORDER[tone],
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        {Icon && (
          <div className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-4" aria-hidden />
          </div>
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="type-section-title">{title}</h2>
            <StatusPill tone={tone} dot>
              {status}
            </StatusPill>
          </div>
          {detail && (
            <div className="mt-0.5 type-body break-words text-muted-foreground">{detail}</div>
          )}
        </div>
      </div>
      {metric && (
        <div className="shrink-0 sm:text-right">
          <div className="type-label">{metric.label}</div>
          <div className="num type-section-title">{metric.value}</div>
        </div>
      )}
      {action && <div className="shrink-0">{action}</div>}
    </section>
  );
}
