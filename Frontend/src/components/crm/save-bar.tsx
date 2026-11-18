import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { UnsavedChangesGuard } from "./unsaved-changes-guard";

/**
 * Sticky "Unsaved changes — Discard · Save" bar for one section's form. Shown only while `dirty`;
 * it also guards leaving the page with unsaved changes. Errors from the server go in `error`.
 */
export function SaveBar({
  dirty,
  saving = false,
  onSave,
  onDiscard,
  error,
  saveLabel = "Save changes",
  message = "Unsaved changes",
  disabled = false,
}: {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  error?: ReactNode;
  saveLabel?: string;
  message?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      {dirty && (
        <div
          role="region"
          aria-label="Unsaved changes"
          className="sticky bottom-0 z-20 -mx-1 mt-4 flex flex-wrap items-center gap-3 rounded-lg border bg-surface-raised px-4 py-3 shadow-lg"
        >
          <div className="min-w-0 flex-1 type-body">
            <span className="font-medium">{message}</span>
            {error && (
              <p role="alert" className="type-small text-danger-soft-foreground">
                {error}
              </p>
            )}
          </div>
          <Button type="button" variant="ghost" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
          <Button type="button" onClick={onSave} disabled={saving || disabled}>
            {saving ? "Saving…" : saveLabel}
          </Button>
        </div>
      )}
    </>
  );
}
