import type { ReactNode } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export interface SectionTab {
  id: string;
  label: string;
  content: ReactNode;
  /** Small count / marker after the label (e.g. errors in that tab). */
  badge?: ReactNode;
}

/**
 * Underlined tabs inside a section (Connection · Safety & limits · Monitoring …). Controlled, so the
 * page can keep the tab in the URL. `keepMounted` tabs stay in the DOM while hidden — use it for tabs
 * that share one form, so their unsaved edits and validation survive switching.
 */
export function SectionTabs({
  label,
  tabs,
  value,
  onValueChange,
  keepMounted = [],
  className,
}: {
  label: string;
  tabs: SectionTab[];
  value: string;
  onValueChange: (id: string) => void;
  keepMounted?: string[];
  className?: string;
}) {
  const active = tabs.some((t) => t.id === value) ? value : (tabs[0]?.id ?? "");
  return (
    <TabsPrimitive.Root value={active} onValueChange={onValueChange} className={className}>
      <TabsPrimitive.List
        aria-label={label}
        className="-mx-1 flex gap-1 overflow-x-auto border-b px-1"
      >
        {tabs.map((t) => (
          <TabsPrimitive.Trigger
            key={t.id}
            value={t.id}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 type-body text-muted-foreground",
              "hover:text-foreground data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-foreground",
            )}
          >
            {t.label}
            {t.badge}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {tabs.map((t) => (
        <TabsPrimitive.Content
          key={t.id}
          value={t.id}
          {...(keepMounted.includes(t.id) ? { forceMount: true as const } : {})}
          className="pt-4 data-[state=inactive]:hidden"
        >
          {t.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
