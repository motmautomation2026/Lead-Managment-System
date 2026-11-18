import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bot,
  CalendarDays,
  CircleUser,
  Factory,
  Gauge,
  KeyRound,
  ListChecks,
  Mail,
  MessageCircle,
  Network,
  Palette,
  PenLine,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  BookOpen,
  Users,
  UserCog,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/crm/page-header";
import { EmptyState } from "@/components/crm/empty-state";
import { SectionLayout, type SectionNavGroup } from "@/components/crm/section-layout";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useIsAdmin, useSession } from "@/store";
import { useWorkspace } from "@/store/workspace-context";
import {
  SETTINGS_GROUPS,
  canOpen,
  searchSettings,
  sectionForPath,
  settingsPath,
  visibleSections,
  type SettingEntry,
  type SettingsSectionId,
  type SettingsViewer,
} from "./settings-search";

const ICONS: Record<SettingsSectionId, LucideIcon> = {
  team: Users,
  assignment: Network,
  email: Mail,
  whatsapp: MessageCircle,
  calendar: CalendarDays,
  "ai-agent": Bot,
  "ai-limits": SlidersHorizontal,
  "message-rules": ListChecks,
  playbook: BookOpen,
  style: PenLine,
  industries: Factory,
  profile: CircleUser,
  appearance: Palette,
  users: UserCog,
  workspaces: KeyRound,
  health: Gauge,
};

function useSettingsViewer(): SettingsViewer {
  const isAdmin = useIsAdmin();
  const { canManageUsers, isSuperAdmin } = useSession();
  return { isAdmin, canManageUsers, isSuperAdmin };
}

/** Sub-nav groups for this viewer (hidden, not disabled), plus the Knowledge link under AI for everyone. */
function settingsNavGroups(viewer: SettingsViewer): SectionNavGroup[] {
  const sections = visibleSections(viewer);
  return SETTINGS_GROUPS.map((group) => ({
    label: group,
    items: [
      ...sections
        .filter((s) => s.group === group)
        .map((s) => ({ id: s.id, label: s.label, to: settingsPath(s.id), icon: ICONS[s.id] })),
      ...(group === "AI"
        ? [
            {
              id: "knowledge",
              label: "Knowledge & assets",
              to: "/knowledge" as const,
              icon: BookOpen,
              leavesSection: true,
            },
          ]
        : []),
    ],
  })).filter((g) => g.items.length > 0);
}

/**
 * /settings (UX-1): left sub-nav with search, one section per route below it (`<Outlet />`). Phones: `/settings`
 * is the section list, a section shows "‹ All settings". Sections the viewer can't open are hidden; opening one
 * by URL shows "No access". A `#field` in the URL (from the search) scrolls to and focuses that field.
 */
export function SettingsLayout() {
  const viewer = useSettingsViewer();
  const { currentWorkspace, isLoading } = useWorkspace();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hash = useRouterState({ select: (s) => s.location.hash });
  const section = sectionForPath(pathname);
  const groups = useMemo(
    () => settingsNavGroups(viewer),
    [viewer.isAdmin, viewer.canManageUsers, viewer.isSuperAdmin], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useJumpToField(pathname, hash);

  const body = !section ? (
    <Outlet />
  ) : !canOpen(section.access, viewer) ? (
    <EmptyState
      icon={ShieldCheck}
      title="No access"
      text="Your role in this workspace can't open this section. Ask an admin if you need it."
    />
  ) : section.workspace && !currentWorkspace ? (
    <EmptyState
      title={isLoading ? "Loading workspace…" : "No workspace is selected"}
      text="Pick a workspace in the sidebar to see its settings."
    />
  ) : (
    <Outlet />
  );

  return (
    <div>
      <PageHeader
        title="Settings"
        description={
          currentWorkspace
            ? `Settings for ${currentWorkspace.name} and your account.`
            : "Your account settings."
        }
      />
      <SectionLayout
        navLabel="Settings sections"
        groups={groups}
        activeId={section?.id ?? null}
        showListOnPhone={!section}
        backTo="/settings"
        backLabel="All settings"
        navHeader={<SettingsSearchBox viewer={viewer} />}
      >
        {body}
      </SectionLayout>
    </div>
  );
}

/** After a jump (`#id`), wait for the section to render the field, then scroll to and focus it. */
function useJumpToField(pathname: string, hash: string) {
  useEffect(() => {
    if (!hash) return;
    let frame = 0;
    let tries = 0;
    const find = () => {
      const el = document.getElementById(decodeURIComponent(hash));
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.focus({ preventScroll: true });
      } else if (tries++ < 60) frame = requestAnimationFrame(find);
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, [pathname, hash]);
}

/** Finds a section or a setting by name and opens it (its tab, focused on its field). */
export function SettingsSearchBox({ viewer }: { viewer: SettingsViewer }) {
  const navigate = useNavigate();
  const listId = useId();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchSettings(q, viewer), [q, viewer]);
  const open = (entry: SettingEntry) => {
    setQ("");
    void navigate({
      to: settingsPath(entry.section),
      search: (entry.tab ? { tab: entry.tab } : {}) as never,
      ...(entry.anchor ? { hash: entry.anchor } : {}),
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const by = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (results.length ? (i + by + results.length) % results.length : 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      open(results[active]);
    } else if (e.key === "Escape") setQ("");
  };
  const label = (s: SettingsSectionId) =>
    visibleSections(viewer).find((x) => x.id === s)?.label ?? "";

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
        aria-hidden
      />
      <Input
        role="combobox"
        aria-label="Search settings"
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        placeholder="Search settings"
        className="pl-8"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {q.trim() && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Settings found"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {results.length === 0 ? (
            <li className="px-2 py-1.5 type-small text-muted-foreground">No setting found.</li>
          ) : (
            results.map((r, i) => (
              <li
                key={`${r.section}-${r.label}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={cn(
                  "cursor-pointer rounded-sm px-2 py-1.5",
                  i === active && "bg-accent text-accent-foreground",
                )}
                onMouseEnter={() => setActive(i)}
                // mousedown: before the input's blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  open(r);
                }}
              >
                <div className="type-body">{r.label}</div>
                {r.label !== label(r.section) && (
                  <div className="type-small text-muted-foreground">{label(r.section)}</div>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
