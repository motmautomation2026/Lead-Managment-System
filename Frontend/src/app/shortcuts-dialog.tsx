import { Fragment } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LOCAL_SHORTCUTS, SHORTCUTS } from "@/app/shortcuts";

const ALL = [...SHORTCUTS, ...LOCAL_SHORTCUTS] as ReadonlyArray<{
  id: string;
  keys: readonly string[];
  label: string;
  group: string;
}>;

const isMac = () => {
  try {
    return /Mac|iPhone|iPad/.test(navigator.platform);
  } catch {
    return false;
  }
};

/** Lists every shortcut from the registry (`?` or user menu → Keyboard shortcuts). */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const groups = [...new Set(ALL.map((s) => s.group))];
  const keyLabel = (key: string) =>
    key === "mod" ? (isMac() ? "⌘" : "Ctrl") : key.length === 1 ? key.toUpperCase() : key;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            They work anywhere except while typing in a field or with a dialog open.
          </DialogDescription>
        </DialogHeader>
        {groups.map((group) => (
          <section key={group} aria-label={group}>
            <h3 className="mb-1 type-label text-muted-foreground">{group}</h3>
            <dl className="divide-y">
              {ALL.filter((s) => s.group === group).map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-4 py-1.5">
                  <dt className="type-body">{s.label}</dt>
                  <dd className="flex shrink-0 items-center gap-1 type-small text-muted-foreground">
                    {s.keys.map((key, i) => (
                      <Fragment key={key}>
                        {i > 0 && <span>{s.keys[0] === "mod" ? "+" : "then"}</span>}
                        <kbd className="min-w-6 rounded border bg-muted px-1.5 py-0.5 text-center font-mono text-xs text-foreground">
                          {keyLabel(key)}
                        </kbd>
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}
