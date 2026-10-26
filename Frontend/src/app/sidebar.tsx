import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Check, ChevronsUpDown, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { BrandLogo } from "@/components/common/brand-logo";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NAV_GROUPS, SETTINGS_NAV, isNavActive, type NavItem } from "@/app/nav";
import { useCompanyDuplicatesCount, useIsAdmin, useTaskCount } from "@/store";
import { useWorkspace } from "@/store/workspace-context";
import { cn } from "@/lib/utils";

/**
 * Sidebar content, used both docked (lg+) and inside the mobile Sheet.
 * `collapsed` shows icons only, with tooltips; `onNavigate` closes the Sheet.
 */
export function AppSidebar({
  collapsed = false,
  onToggleCollapsed,
  onNavigate,
  onCreateWorkspace,
}: {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: (() => void) | undefined;
  onCreateWorkspace: () => void;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isAdmin = useIsAdmin();
  // Settings holds Users for admins (C6b: no separate Admin item).
  const bottom = [SETTINGS_NAV];
  // Admins: open duplicate-company suggestions (cheap count, cached 60 s).
  const duplicates = useCompanyDuplicatesCount({}, isAdmin).data?.count ?? 0;
  // My overdue tasks: the same params (and cache) as the Tasks page's Overdue tab; refreshWork
  // refreshes it with the list.
  const overdue = useTaskCount({ ownerId: ["me"], due: "overdue" }).data?.count ?? 0;
  const badgeFor = (to: NavItem["to"]) =>
    to === "/companies" && duplicates > 0
      ? {
          badge: duplicates,
          badgeLabel: `${duplicates} possible duplicate compan${duplicates === 1 ? "y" : "ies"} to review`,
        }
      : to === "/tasks" && overdue > 0
        ? { badge: overdue, badgeLabel: `${overdue} overdue task${overdue === 1 ? "" : "s"}` }
        : {};
  const link = (item: NavItem) => (
    <SidebarLink
      key={item.to}
      item={item}
      active={isNavActive(item.to, pathname)}
      collapsed={collapsed}
      onNavigate={onNavigate}
      {...badgeFor(item.to)}
    />
  );

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className={cn("flex shrink-0 items-center gap-2 py-4", collapsed ? "px-2" : "px-3")}>
        {!collapsed && <BrandLogo caption="MOTM Flow · Sales Automation" className="min-w-0" />}
        {onToggleCollapsed && (
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-8 shrink-0 text-muted-foreground", !collapsed && "ml-auto")}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1">
        <nav aria-label="Main" className={cn("space-y-4 pb-4", collapsed ? "px-2" : "px-3")}>
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              {collapsed ? (
                <div className="mx-2 mb-1 border-t border-sidebar-border" />
              ) : (
                <div className="mb-1 px-2.5 type-label">{group.label}</div>
              )}
              <div className="space-y-0.5">{group.items.map(link)}</div>
            </div>
          ))}
        </nav>
      </ScrollArea>

      <div
        className={cn(
          "space-y-0.5 border-t border-sidebar-border py-2",
          collapsed ? "px-2" : "px-3",
        )}
      >
        {bottom.map(link)}
        <WorkspaceSwitcher collapsed={collapsed} onCreateWorkspace={onCreateWorkspace} />
      </div>
    </div>
  );
}

function SidebarLink({
  item,
  active,
  collapsed,
  onNavigate,
  badge,
  badgeLabel,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: (() => void) | undefined;
  badge?: number | undefined;
  badgeLabel?: string;
}) {
  const node = (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors hover:bg-sidebar-accent",
        collapsed && "justify-center px-0",
        active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
      )}
    >
      <item.icon
        className={cn("size-4 shrink-0", active ? "text-sidebar-primary" : "text-muted-foreground")}
        aria-hidden
      />
      <span className={cn(collapsed && "sr-only")}>{item.label}</span>
      {badge !== undefined && (
        <span
          title={badgeLabel}
          className={cn(
            "rounded-full bg-warning-soft text-warning-soft-foreground",
            collapsed
              ? "absolute top-1 right-1 size-2"
              : "ml-auto px-1.5 text-[10px] font-semibold",
          )}
        >
          {!collapsed && <span aria-hidden>{badge}</span>}
          <span className="sr-only">, {badgeLabel}</span>
        </span>
      )}
    </Link>
  );
  if (!collapsed) return node;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{node}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

/** Same behaviour as before C1: list + switch + create; id kept by workspace-context. */
function WorkspaceSwitcher({
  collapsed,
  onCreateWorkspace,
}: {
  collapsed: boolean;
  onCreateWorkspace: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { workspaces, currentWorkspaceId, currentWorkspace, setCurrentWorkspaceId, isLoading } =
    useWorkspace();
  const name = currentWorkspace?.name ?? (isLoading ? "Loading…" : "No workspace");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-sidebar-accent",
            collapsed && "justify-center px-0",
          )}
          aria-label={`Switch workspace (current: ${name})`}
          title={collapsed ? name : undefined}
        >
          <BrandLogo variant="mark" className="size-6 shrink-0" />
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1 text-xs">
                <div className="truncate font-medium">{name}</div>
                <div className="text-muted-foreground">Workspace · IST</div>
              </div>
              <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side={collapsed ? "right" : "top"} className="w-64 p-1">
        <div className="max-h-64 overflow-y-auto">
          {workspaces.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {isLoading ? "Loading workspaces…" : "No workspaces yet."}
            </div>
          )}
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent",
                workspace.id === currentWorkspaceId && "bg-accent",
              )}
              onClick={() => {
                setCurrentWorkspaceId(workspace.id);
                setOpen(false);
              }}
            >
              <span className="truncate">{workspace.name}</span>
              {workspace.id === currentWorkspaceId && <Check className="size-3.5 shrink-0" />}
            </button>
          ))}
        </div>
        <div className="mt-1 border-t pt-1">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-primary hover:bg-accent"
            onClick={() => {
              setOpen(false);
              onCreateWorkspace();
            }}
          >
            <Plus className="size-3.5" /> Create workspace
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
