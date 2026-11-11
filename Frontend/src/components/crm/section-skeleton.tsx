import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading placeholder shaped like a section (status card, tab row, fields) so nothing jumps when the
 * data arrives. `rows` = field rows.
 */
export function SectionSkeleton({
  label = "Loading",
  rows = 4,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div role="status" aria-label={label} className="space-y-4">
      <Skeleton className="h-[4.5rem] w-full rounded-lg" />
      <Skeleton className="h-9 w-full max-w-md" />
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: rows * 2 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
