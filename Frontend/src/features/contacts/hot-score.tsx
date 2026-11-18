import { StatusPill, type PillTone } from "@/components/crm/status-pill";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HOT_BAND_LABEL, hotReasonText, type HotBand } from "./hot-score-labels";

const HOT_BAND_TONE: Record<HotBand, PillTone> = {
  hot: "danger",
  warm: "warning",
  cold: "neutral",
};

/** Band pill + score; tap or click shows the reasons. Nothing until the first score. */
export function HotScorePill({
  score,
  band,
  reasons,
}: {
  score: number | null | undefined;
  band: string | null | undefined;
  reasons: string[] | null | undefined;
}) {
  if (score == null || !band) return <span className="text-muted-foreground">–</span>;
  const b = band as HotBand;
  const why = (reasons ?? []).map(hotReasonText);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          // A list row opens the contact on click: this opens the reasons instead.
          onClick={(e) => e.stopPropagation()}
          aria-label={`${HOT_BAND_LABEL[b]} lead, score ${score}. Show why`}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <StatusPill tone={HOT_BAND_TONE[b]}>
            {HOT_BAND_LABEL[b]} · {score}
          </StatusPill>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3 text-sm" onClick={(e) => e.stopPropagation()}>
        <p className="font-medium">Why {HOT_BAND_LABEL[b].toLowerCase()}</p>
        {why.length ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            {why.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-muted-foreground">Nothing known about this contact yet.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
