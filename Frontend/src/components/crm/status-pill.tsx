import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PillTone = "neutral" | "primary" | "info" | "success" | "warning" | "danger";

const TONES: Record<PillTone, string> = {
  neutral: "bg-muted text-muted-foreground border-border",
  primary: "bg-accent text-accent-foreground border-primary/25",
  info: "bg-info-soft text-info-soft-foreground border-info/25",
  success: "bg-success-soft text-success-soft-foreground border-success/25",
  warning: "bg-warning-soft text-warning-soft-foreground border-warning/40",
  danger: "bg-danger-soft text-danger-soft-foreground border-danger/25",
};

/** Small rounded label (stage, status, chip) coloured only from theme tokens. */
export function StatusPill({
  tone = "neutral",
  dot = false,
  children,
  className,
}: {
  tone?: PillTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}
