import type { ReactNode } from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface HeaderMenuAction {
  label: string;
  onSelect: () => void;
  icon?: LucideIcon;
  destructive?: boolean;
  disabled?: boolean;
}

/**
 * Top of every page: title (+ optional total count), description, secondary
 * `actions`, a "More" menu (`menuActions`), then the `primaryAction`; a `tabs` slot (e.g. ViewTabs)
 * and a `filters` row below. `heading` replaces the title block entirely (record pages).
 */
export function PageHeader({
  title,
  count,
  description,
  actions,
  menuActions,
  primaryAction,
  tabs,
  filters,
  heading,
}: {
  title: string;
  count?: number | null;
  description?: ReactNode;
  actions?: ReactNode;
  menuActions?: HeaderMenuAction[];
  primaryAction?: ReactNode;
  tabs?: ReactNode;
  filters?: ReactNode;
  heading?: ReactNode;
}) {
  const hasMenu = Boolean(menuActions?.length);
  return (
    <div className="border-b bg-card px-4 pt-5 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-4">
        {heading ?? (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="type-page-title">{title}</h1>
              {count != null && (
                <span className="num rounded-full bg-muted px-2 py-0.5 type-small font-medium text-muted-foreground">
                  {count.toLocaleString("en-IN")}
                </span>
              )}
            </div>
            {description && <p className="mt-0.5 type-body text-muted-foreground">{description}</p>}
          </div>
        )}
        {(actions || hasMenu || primaryAction) && (
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            {hasMenu && (
              // modal={false}: an item may open a Dialog (C1-ui §4).
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {menuActions!.map((a) => (
                    <DropdownMenuItem
                      key={a.label}
                      disabled={a.disabled ?? false}
                      onSelect={a.onSelect}
                      className={a.destructive ? "text-destructive focus:text-destructive" : ""}
                    >
                      {a.icon && <a.icon aria-hidden />}
                      {a.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {primaryAction}
          </div>
        )}
      </div>
      {tabs}
      {filters && <div className="pb-3">{filters}</div>}
    </div>
  );
}
