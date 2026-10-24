import type { ReactNode } from "react";

/**
 * Top of every page: title (+ optional total count), description, secondary
 * `actions` then the `primaryAction`, and a `tabs` slot (e.g. ViewTabs) below.
 * `heading` replaces the title block entirely (record pages).
 */
export function PageHeader({
  title,
  count,
  description,
  actions,
  primaryAction,
  tabs,
  heading,
}: {
  title: string;
  count?: number | null;
  description?: ReactNode;
  actions?: ReactNode;
  primaryAction?: ReactNode;
  tabs?: ReactNode;
  heading?: ReactNode;
}) {
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
        {(actions || primaryAction) && (
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            {primaryAction}
          </div>
        )}
      </div>
      {tabs}
    </div>
  );
}
