import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMediaQuery } from "@/lib/use-media-query";

export interface RailCard {
  id: string;
  title: string;
  content: ReactNode;
  /** Shown next to the title, e.g. a count. */
  badge?: ReactNode;
  /** A small action in the card header (e.g. "+ Create deal"); stays visible while collapsed. */
  action?: ReactNode;
  /** First visit only; afterwards the viewer's choice is remembered. Default open. */
  defaultOpen?: boolean;
}

const railKey = (key: string) => `motmflow.rail.${key}`;

function readRail(key: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(railKey(key));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** Open/closed rail cards per record type, remembered in the browser (unreadable storage = defaults). */
function useRailState(key: string) {
  const [state, setState] = useState(() => readRail(key));
  const toggle = (id: string, open: boolean) =>
    setState((prev) => {
      const next = { ...prev, [id]: open };
      try {
        window.localStorage.setItem(railKey(key), JSON.stringify(next));
      } catch {
        // Storage unavailable: the choice lasts for this page only.
      }
      return next;
    });
  return [state, toggle] as const;
}

/**
 * UX-3 record page (contact, company, deal): a sticky header (identity, pills, primary actions),
 * one main column (the Activity feed with its composer) and a right rail of collapsible cards.
 * A card's content mounts only while it is open, so each card loads its own data in parallel and
 * never blocks the header. Below lg the rail becomes tabs under the header.
 */
export function RecordShell({
  breadcrumb,
  header,
  banner,
  main,
  mainLabel = "Activity",
  rail,
  railKey: key,
}: {
  breadcrumb?: ReactNode;
  header: ReactNode;
  /** Under the header, scrolls with the page (e.g. the Do Not Contact banner). */
  banner?: ReactNode;
  main: ReactNode;
  mainLabel?: string;
  rail: RailCard[];
  railKey: string;
}) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const [openState, toggle] = useRailState(key);
  const isOpen = (card: RailCard) => openState[card.id] ?? card.defaultOpen ?? true;

  return (
    <div className="pb-10">
      {/* top-14: below the app's sticky top bar (h-14). */}
      <header className="sticky top-14 z-20 border-b bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
        {breadcrumb}
        {header}
      </header>
      {banner}
      {wide ? (
        <div className="grid grid-cols-[minmax(0,1fr)_22rem] gap-6 px-6 pt-4">
          <section className="min-w-0 space-y-4" aria-label={mainLabel}>
            {main}
          </section>
          <aside className="min-w-0 space-y-3" aria-label="Details">
            {rail.map((card) => (
              <RailCardView
                key={card.id}
                card={card}
                open={isOpen(card)}
                onToggle={(open) => toggle(card.id, open)}
              />
            ))}
          </aside>
        </div>
      ) : (
        <Tabs defaultValue="main" className="min-w-0 px-4 pt-3">
          <div className="overflow-x-auto">
            <TabsList>
              <TabsTrigger value="main">{mainLabel}</TabsTrigger>
              {rail.map((card) => (
                <TabsTrigger key={card.id} value={card.id}>
                  {card.title}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="main" className="mt-3 space-y-4">
            {main}
          </TabsContent>
          {rail.map((card) => (
            <TabsContent key={card.id} value={card.id} className="mt-3 space-y-3">
              {card.action && <div className="flex justify-end">{card.action}</div>}
              {card.content}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

function RailCardView({
  card,
  open,
  onToggle,
}: {
  card: RailCard;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const bodyId = `rail-${card.id}`;
  return (
    <Card className="p-0">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onToggle(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left type-section-title"
        >
          <Chevron className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{card.title}</span>
          {card.badge != null && (
            <span className="num font-normal text-muted-foreground">{card.badge}</span>
          )}
        </button>
        {card.action}
      </div>
      {open && (
        <div id={bodyId} className="border-t px-4 py-3">
          {card.content}
        </div>
      )}
    </Card>
  );
}
