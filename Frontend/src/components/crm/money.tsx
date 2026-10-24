import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Amount via `formatMoney` (INR grouping; `compact` = lakh/crore); exact value on hover. */
export function Money({
  amount,
  currency = "INR",
  compact = false,
  className,
}: {
  amount: number | null | undefined;
  currency?: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("num", className)} title={formatMoney(amount, currency)}>
      {formatMoney(amount, currency, compact)}
    </span>
  );
}
