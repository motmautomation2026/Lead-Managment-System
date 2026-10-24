import { useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  activeFilterCount,
  filterSummary,
  isFilterActive,
  type DateRange,
  type FilterDef,
  type FilterValue,
  type FilterValues,
  type NumberRange,
} from "@/components/crm/filter-model";
import { cn } from "@/lib/utils";

/**
 * Quick filter chips (each opens a popover editor with Apply / Clear), a
 * "More filters" Sheet for `moreFilters`, the active count and "Clear all".
 * Controlled: `values` in, `onChange(next)` out (pages keep them in the URL).
 */
export function FilterBar({
  filters,
  moreFilters = [],
  values,
  onChange,
}: {
  filters: FilterDef[];
  moreFilters?: FilterDef[];
  values: FilterValues;
  onChange: (values: FilterValues) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const count = activeFilterCount(values);
  const set = (id: string, value: FilterValue | undefined) => onChange({ ...values, [id]: value });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filters.map((def) => (
        <FilterChip key={def.id} def={def} value={values[def.id]} onApply={(v) => set(def.id, v)} />
      ))}
      {moreFilters.length > 0 && (
        <Button variant="outline" size="sm" onClick={() => setMoreOpen(true)}>
          <SlidersHorizontal /> More filters
        </Button>
      )}
      {count > 0 && (
        <>
          <span className="type-small text-muted-foreground" aria-live="polite">
            {count} active
          </span>
          <Button variant="ghost" size="sm" onClick={() => onChange({})}>
            Clear all
          </Button>
        </>
      )}
      <MoreFiltersSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        filters={moreFilters}
        values={values}
        onApply={(next) => onChange({ ...values, ...next })}
      />
    </div>
  );
}

function FilterChip({
  def,
  value,
  onApply,
}: {
  def: FilterDef;
  value: FilterValue | undefined;
  onApply: (value: FilterValue | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const summary = filterSummary(def, value);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setDraft(value);
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "max-w-64",
            summary && "border-primary/40 bg-accent text-accent-foreground",
          )}
        >
          <span className="truncate">
            {def.label}
            {summary && `: ${summary}`}
          </span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <FilterEditor def={def} value={draft} onChange={setDraft} />
        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onApply(undefined);
              setOpen(false);
            }}
          >
            Clear
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onApply(isFilterActive(draft) ? draft : undefined);
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MoreFiltersSheet({
  open,
  onOpenChange,
  filters,
  values,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: FilterDef[];
  values: FilterValues;
  onApply: (values: FilterValues) => void;
}) {
  const [draft, setDraft] = useState<FilterValues>({});
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (o) setDraft(Object.fromEntries(filters.map((f) => [f.id, values[f.id]])));
        onOpenChange(o);
      }}
    >
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>More filters</SheetTitle>
        </SheetHeader>
        <div className="space-y-5">
          {filters.map((def) => (
            <fieldset key={def.id} className="space-y-2">
              <legend className="type-label">{def.label}</legend>
              <FilterEditor
                def={def}
                value={draft[def.id]}
                onChange={(v) => setDraft((d) => ({ ...d, [def.id]: v }))}
              />
            </fieldset>
          ))}
        </div>
        <SheetFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onApply(
                Object.fromEntries(
                  Object.entries(draft).map(([k, v]) => [k, isFilterActive(v) ? v : undefined]),
                ),
              );
              onOpenChange(false);
            }}
          >
            Apply filters
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function FilterEditor({
  def,
  value,
  onChange,
}: {
  def: FilterDef;
  value: FilterValue | undefined;
  onChange: (value: FilterValue | undefined) => void;
}) {
  switch (def.type) {
    case "multi": {
      const picked = Array.isArray(value) ? value : [];
      return (
        <div className="max-h-60 space-y-1 overflow-y-auto">
          {def.options.map((o) => {
            const id = `filter-${def.id}-${o.value}`;
            return (
              <div key={o.value} className="flex items-center gap-2 py-0.5">
                <Checkbox
                  id={id}
                  checked={picked.includes(o.value)}
                  onCheckedChange={(c) =>
                    onChange(c ? [...picked, o.value] : picked.filter((p) => p !== o.value))
                  }
                />
                <Label htmlFor={id} className="font-normal">
                  {o.label}
                </Label>
              </div>
            );
          })}
        </div>
      );
    }
    case "boolean":
      return (
        <div className="flex gap-1" role="radiogroup" aria-label={def.label}>
          {(
            [
              [undefined, "Any"],
              [true, def.trueLabel ?? "Yes"],
              [false, def.falseLabel ?? "No"],
            ] as const
          ).map(([v, text]) => (
            <Button
              key={text}
              type="button"
              role="radio"
              aria-checked={value === v}
              size="sm"
              variant={value === v ? "default" : "outline"}
              onClick={() => onChange(v)}
            >
              {text}
            </Button>
          ))}
        </div>
      );
    case "dateRange": {
      const range = (value ?? {}) as DateRange;
      const set = (patch: DateRange) => onChange({ ...range, ...patch });
      return (
        <div className="grid grid-cols-2 gap-2">
          <Label className="grid gap-1 type-small">
            From
            <Input
              type="date"
              value={range.from ?? ""}
              onChange={(e) => set({ from: e.target.value || undefined })}
            />
          </Label>
          <Label className="grid gap-1 type-small">
            To
            <Input
              type="date"
              value={range.to ?? ""}
              onChange={(e) => set({ to: e.target.value || undefined })}
            />
          </Label>
        </div>
      );
    }
    case "numberRange": {
      const range = (value ?? {}) as NumberRange;
      const num = (s: string) => (s === "" || Number.isNaN(Number(s)) ? undefined : Number(s));
      const set = (patch: NumberRange) => onChange({ ...range, ...patch });
      return (
        <div className="grid grid-cols-2 gap-2">
          <Label className="grid gap-1 type-small">
            Min
            <Input
              type="number"
              min={0}
              value={range.min ?? ""}
              onChange={(e) => set({ min: num(e.target.value) })}
            />
          </Label>
          <Label className="grid gap-1 type-small">
            Max
            <Input
              type="number"
              min={0}
              value={range.max ?? ""}
              onChange={(e) => set({ max: num(e.target.value) })}
            />
          </Label>
        </div>
      );
    }
  }
}
