import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Initials avatar for a user or contact; `name` null shows "–" (e.g. unassigned). */
export function UserAvatar({
  name,
  size = "md",
  className,
}: {
  name: string | null | undefined;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      title={name ?? undefined}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full bg-primary/10 font-semibold uppercase text-primary",
        size === "sm" ? "size-6 text-[10px]" : "size-8 text-xs",
        className,
      )}
    >
      {name ? initials(name.trim()) : "–"}
    </span>
  );
}
