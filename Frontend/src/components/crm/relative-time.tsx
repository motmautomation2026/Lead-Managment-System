import { fmtDateTime, relDay } from "@/lib/format";

/** "Today, 3:10 pm" / "12 Oct 2026 (4d ago)" in IST, full date-time on hover. */
export function RelativeTime({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  if (!value) return <span className={className}>–</span>;
  return (
    <time dateTime={value} title={fmtDateTime(value)} className={className}>
      {relDay(value)}
    </time>
  );
}
