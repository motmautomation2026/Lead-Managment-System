import type { ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * Right-hand panel for one item's details without leaving the list (a WhatsApp number, a user, a
 * task…). Full width on phones. The body scrolls; `footer` (e.g. a SaveBar) stays at the bottom.
 */
export function DetailDrawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b p-4 pr-12">
          <SheetTitle>{title}</SheetTitle>
          {/* Always rendered: Radix warns when a dialog has no description. */}
          <SheetDescription className={description ? undefined : "sr-only"}>
            {description ?? "Details"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="border-t p-3">{footer}</div>}
      </SheetContent>
    </Sheet>
  );
}
