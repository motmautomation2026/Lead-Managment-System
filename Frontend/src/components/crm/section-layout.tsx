import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, ExternalLink, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SectionNavItem {
  id: string;
  label: string;
  to: NonNullable<LinkProps["to"]>;
  icon?: LucideIcon;
  /** Opens another page (e.g. Knowledge) instead of a section. */
  leavesSection?: boolean;
}
export interface SectionNavGroup {
  label: string;
  items: SectionNavItem[];
}

/**
 * A page with a left sub-navigation and one section per route (Settings; later record setups).
 * Desktop (lg+): nav left, the open section right. Phones: `showListOnPhone` shows only the nav as a
 * list page; otherwise only the section with a "back" link to the list.
 */
export function SectionLayout({
  navLabel,
  groups,
  activeId,
  navHeader,
  showListOnPhone,
  backTo,
  backLabel,
  children,
}: {
  navLabel: string;
  groups: SectionNavGroup[];
  activeId: string | null;
  navHeader?: ReactNode;
  showListOnPhone: boolean;
  backTo: NonNullable<LinkProps["to"]>;
  backLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-24 sm:px-6 lg:flex-row lg:gap-8">
      <nav
        aria-label={navLabel}
        className={cn("shrink-0 lg:block lg:w-56", showListOnPhone ? "block" : "hidden")}
      >
        <div className="lg:sticky lg:top-16 space-y-4">
          {navHeader}
          {groups.map((group) => (
            <div key={group.label}>
              <h2 className="mb-1 px-3 type-label uppercase tracking-wide">{group.label}</h2>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const current = item.id === activeId;
                  return (
                    <li key={item.id}>
                      <Link
                        to={item.to}
                        aria-current={current ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-3 py-2.5 type-body lg:py-1.5",
                          current
                            ? "bg-accent font-medium text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                        )}
                      >
                        {item.icon && <item.icon className="size-4 shrink-0" aria-hidden />}
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.leavesSection ? (
                          <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                        ) : (
                          <ChevronRight className="size-4 shrink-0 lg:hidden" aria-hidden />
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
      <div className={cn("min-w-0 flex-1 lg:block", showListOnPhone ? "hidden" : "block")}>
        <Link
          to={backTo}
          className="mb-3 inline-flex items-center gap-1 type-body text-muted-foreground hover:text-foreground lg:hidden"
        >
          <ChevronLeft className="size-4" aria-hidden />
          {backLabel}
        </Link>
        {children}
      </div>
    </div>
  );
}

/** Title + description at the top of one section. */
export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="type-page-title">{title}</h2>
        {description && <p className="mt-0.5 type-body text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
