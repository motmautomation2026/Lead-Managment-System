import {
  BookOpen,
  Bot,
  Building2,
  CalendarDays,
  FileText,
  House,
  Handshake,
  ListChecks,
  Settings,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { SETTINGS_SECTIONS } from "@/features/settings/settings-search";

export interface NavItem {
  to:
    | "/"
    | "/contacts"
    | "/companies"
    | "/deals"
    | "/tasks"
    | "/meetings"
    | "/proposals"
    | "/automations"
    | "/ai-activity"
    | "/knowledge"
    | "/settings";
  label: string;
  icon: LucideIcon;
}

export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "CRM",
    items: [
      // Contacts are `leads` rows.
      { to: "/contacts", label: "Contacts", icon: Users },
      { to: "/companies", label: "Companies", icon: Building2 },
      { to: "/deals", label: "Deals", icon: Handshake },
    ],
  },
  {
    label: "Work",
    items: [
      { to: "/", label: "Home", icon: House },
      { to: "/tasks", label: "Tasks", icon: ListChecks },
      { to: "/meetings", label: "Meetings", icon: CalendarDays },
      { to: "/proposals", label: "Proposals", icon: FileText },
    ],
  },
  {
    label: "Automation",
    items: [
      { to: "/automations", label: "Workflows", icon: Bot },
      { to: "/ai-activity", label: "AI Activity", icon: Sparkles },
      { to: "/knowledge", label: "Knowledge", icon: BookOpen },
    ],
  },
];

export const SETTINGS_NAV: NavItem = { to: "/settings", label: "Settings", icon: Settings };
const ALL_NAV = [...NAV_GROUPS.flatMap((g) => g.items), SETTINGS_NAV];

export function isNavActive(to: string, pathname: string) {
  return to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`);
}

/** Second-level crumbs under a nav section, by path. */
const SUB_PAGES: Array<[RegExp, string]> = [
  [/^\/contacts\/[^/]+/, "Contact"],
  [/^\/companies\/duplicates/, "Duplicates"],
  [/^\/companies\/[^/]+/, "Company"],
  [/^\/deals\/[^/]+/, "Deal"],
  [/^\/automations\/templates/, "Templates"],
  [/^\/automations\/runs/, "Runs"],
  [/^\/automations\/workflows\/[^/]+/, "Workflow"],
  ...SETTINGS_SECTIONS.map((s): [RegExp, string] => [
    new RegExp(`^/settings/${s.id}(/|$)`),
    s.label,
  ]),
];

export interface Crumb {
  label: string;
  to?: NavItem["to"];
}

/** Breadcrumbs for the top bar: the nav section, then the sub-page if any. */
export function crumbsFor(pathname: string): Crumb[] {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path.startsWith("/dev/ui")) return [{ label: "UI kit" }];
  if (path === "/search") return [{ label: "Search" }];
  const section = ALL_NAV.find((item) => isNavActive(item.to, path));
  if (!section) return [];
  const sub = SUB_PAGES.find(([re]) => re.test(path))?.[1];
  return sub
    ? [{ label: section.label, to: section.to }, { label: sub }]
    : [{ label: section.label }];
}
