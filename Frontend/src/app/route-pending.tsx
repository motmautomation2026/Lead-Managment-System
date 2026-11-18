import { Skeleton } from "@/components/ui/skeleton";

/** Page skeleton while a lazily loaded route chunk downloads. */
export function RoutePending() {
  return (
    <div className="space-y-4 p-4 sm:p-6" role="status" aria-label="Loading page">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-9 w-full max-w-md" />
      <div className="space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
