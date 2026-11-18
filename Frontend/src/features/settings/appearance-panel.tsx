import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTheme } from "@/app/theme-context";
import { label } from "@/lib/labels";
import { DENSITIES, THEMES } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/crm/section-layout";

/** Settings → Appearance: the same theme + density the user menu sets (this browser only). */
export function AppearancePanel() {
  const { theme, setTheme, density, setDensity } = useTheme();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Saved in this browser. The account menu (top right) has the same switches.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Choice label="Theme" options={THEMES} value={theme} onChange={setTheme} />
        <Choice label="Density" options={DENSITIES} value={density} onChange={setDensity} />
      </CardContent>
    </Card>
  );
}

function Choice<T extends string>({
  label: title,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="type-label mb-2">{title}</legend>
      <div role="radiogroup" aria-label={title} className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            onClick={() => onChange(option)}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm",
              value === option
                ? "border-primary bg-primary text-primary-foreground"
                : "hover:bg-accent",
            )}
          >
            {label(option)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Settings → Personal → Appearance. */
export function AppearanceSection() {
  return (
    <>
      <SectionHeader title="Appearance" description="Theme and density in this browser." />
      <AppearancePanel />
    </>
  );
}
