import { Fragment } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Bell, ChevronRight, Keyboard, LogOut, Menu, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/crm/user-avatar";
import { crumbsFor } from "@/app/nav";
import { useTheme } from "@/app/theme-context";
import { messageFromError, useNotifications, useSession } from "@/store";
import { DENSITIES, THEMES, type Density, type ThemePreference } from "@/lib/preferences";
import { relDay } from "@/lib/format";
import { label } from "@/lib/labels";
import { supabase } from "@/lib/supabase-client";
import { cn } from "@/lib/utils";

/** Sticky top bar: mobile menu, breadcrumbs, search, + Create, notifications, user menu. */
export function TopBar({
  onOpenMenu,
  onOpenSearch,
  onCreateContact,
  onCreateCompany,
  onCreateDeal,
  onCreateTask,
  onCreateMeeting,
  createMenuOpen,
  onCreateMenuOpenChange,
  onOpenShortcuts,
}: {
  onOpenMenu: () => void;
  onOpenSearch: () => void;
  onCreateContact: () => void;
  onCreateCompany: () => void;
  onCreateDeal: () => void;
  onCreateTask: () => void;
  onCreateMeeting: () => void;
  /** Controlled so the `n` shortcut can open it. */
  createMenuOpen: boolean;
  onCreateMenuOpenChange: (open: boolean) => void;
  onOpenShortcuts: () => void;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const crumbs = crumbsFor(pathname);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card/80 px-3 backdrop-blur sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 lg:hidden"
        aria-label="Open navigation"
        onClick={onOpenMenu}
      >
        <Menu />
      </Button>

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1 text-sm">
          {crumbs.map((crumb, i) => (
            <Fragment key={crumb.label}>
              {i > 0 && (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <li
                className={cn(
                  "truncate",
                  i === crumbs.length - 1 ? "font-medium" : "text-muted-foreground",
                )}
              >
                {crumb.to ? (
                  <Link to={crumb.to} className="hover:text-foreground">
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page">{crumb.label}</span>
                )}
              </li>
            </Fragment>
          ))}
        </ol>
      </nav>

      <button
        type="button"
        onClick={onOpenSearch}
        className="hidden h-9 w-64 shrink-0 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground shadow-sm hover:bg-accent md:flex"
      >
        <Search className="size-4" aria-hidden />
        <span className="flex-1 text-left">Search…</span>
        <kbd className="rounded border bg-muted px-1 text-[10px]">⌘K</kbd>
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 md:hidden"
        aria-label="Search"
        onClick={onOpenSearch}
      >
        <Search />
      </Button>

      <CreateMenu
        onCreateContact={onCreateContact}
        onCreateCompany={onCreateCompany}
        onCreateDeal={onCreateDeal}
        onCreateTask={onCreateTask}
        onCreateMeeting={onCreateMeeting}
        open={createMenuOpen}
        onOpenChange={onCreateMenuOpenChange}
      />
      <NotificationsMenu />
      <UserMenu onOpenShortcuts={onOpenShortcuts} />
    </header>
  );
}

function CreateMenu({
  onCreateContact,
  onCreateCompany,
  onCreateDeal,
  onCreateTask,
  onCreateMeeting,
  open,
  onOpenChange,
}: {
  onCreateContact: () => void;
  onCreateCompany: () => void;
  onCreateDeal: () => void;
  onCreateTask: () => void;
  onCreateMeeting: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Non-modal: a modal menu's focus trap fights the dialog that "Contact" opens.
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          className="shrink-0 gap-1.5 max-sm:size-9 max-sm:px-0"
          aria-label="Create"
        >
          <Plus />
          <span className="max-sm:hidden">Create</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onCreateContact}>Contact</DropdownMenuItem>
        <DropdownMenuItem onSelect={onCreateCompany}>Company</DropdownMenuItem>
        <DropdownMenuItem onSelect={onCreateDeal}>Deal</DropdownMenuItem>
        <DropdownMenuItem onSelect={onCreateTask}>Task</DropdownMenuItem>
        <DropdownMenuItem onSelect={onCreateMeeting}>Meeting</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NotificationsMenu() {
  const navigate = useNavigate();
  const { notifications, markNotificationsRead } = useNotifications();
  const unread = notifications.filter((n) => !n.read).length;
  return (
    <Popover
      onOpenChange={(o) => {
        if (o) {
          markNotificationsRead().catch((error: unknown) => {
            toast.error(messageFromError(error));
          });
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative shrink-0"
          aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        >
          <Bell />
          {unread > 0 && (
            <span className="absolute right-1.5 top-1.5 grid size-4 place-items-center rounded-full bg-destructive text-[9px] font-semibold text-destructive-foreground">
              {unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1.5rem))] p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">Notifications</div>
        <ScrollArea className="h-96">
          {notifications.map((n) => (
            <button
              key={n.id}
              className="flex w-full gap-2 border-b px-3 py-2.5 text-left last:border-0 hover:bg-accent"
              onClick={() => {
                if (n.leadId)
                  void navigate({ to: "/contacts/$contactId", params: { contactId: n.leadId } });
                else if (n.href === "/automations/runs") void navigate({ to: "/automations/runs" });
                else if (n.href === "/automations") void navigate({ to: "/automations" });
                else if (n.href === "/meetings") void navigate({ to: "/meetings" });
                else if (n.href === "/leads" || n.href === "/contacts")
                  void navigate({ to: "/contacts" });
              }}
            >
              <span
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  n.kind === "danger" && "bg-destructive",
                  n.kind === "warning" && "bg-warning",
                  n.kind === "success" && "bg-success",
                  n.kind === "info" && "bg-info",
                )}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{n.title}</span>
                <span className="block text-xs text-muted-foreground">{n.detail}</span>
                <span className="block pt-0.5 text-[11px] text-muted-foreground">
                  {relDay(n.at)}
                </span>
              </span>
            </button>
          ))}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function UserMenu({ onOpenShortcuts }: { onOpenShortcuts: () => void }) {
  const { currentUser } = useSession();
  const { theme, setTheme, density, setDensity } = useTheme();
  // Non-modal: "Keyboard shortcuts" opens a dialog, and a modal menu's focus trap fights it.
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Account menu"
        >
          <UserAvatar name={currentUser?.name} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-1.5">
          <div className="truncate text-sm font-medium">{currentUser?.name ?? "Loading…"}</div>
          <div className="type-small text-muted-foreground">
            {currentUser?.role ?? "Salesperson"}
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePreference)}>
          {THEMES.map((t) => (
            <DropdownMenuRadioItem key={t} value={t}>
              {label(t)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuLabel>Density</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={density} onValueChange={(v) => setDensity(v as Density)}>
          {DENSITIES.map((d) => (
            <DropdownMenuRadioItem key={d} value={d}>
              {label(d)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenShortcuts}>
          <Keyboard /> Keyboard shortcuts
          <kbd className="ml-auto rounded border bg-muted px-1 text-[10px] max-sm:hidden">?</kbd>
        </DropdownMenuItem>
        {supabase && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void supabase?.auth.signOut()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
