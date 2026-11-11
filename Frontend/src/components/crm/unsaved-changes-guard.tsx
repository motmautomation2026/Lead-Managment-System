import { useBlocker } from "@tanstack/react-router";
import { ConfirmDialog } from "@/components/common/confirm-dialog";

/**
 * While `when` is true, leaving the page (another route, Back, closing the tab) asks first.
 * Search-param changes on the same path (tabs, drawers) are not "leaving".
 */
export function UnsavedChangesGuard({ when }: { when: boolean }) {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => when && current.pathname !== next.pathname,
    enableBeforeUnload: () => when,
    withResolver: true,
  });
  return (
    <ConfirmDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => !open && blocker.reset?.()}
      title="Leave without saving?"
      description="Your changes in this section are not saved. Leaving discards them."
      confirmLabel="Discard and leave"
      cancelLabel="Keep editing"
      onConfirm={() => blocker.proceed?.()}
    />
  );
}
