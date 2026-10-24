import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface ViewTab {
  id: string;
  label: string;
}

/**
 * Index-page views (All · My · saved views). The first `maxVisible` show as tabs,
 * the rest in a "More" menu (the active one always stays visible). Props only;
 * pages wire it to /saved-views.
 */
export function ViewTabs({
  views,
  activeId,
  onChange,
  onSaveView,
  maxVisible = 5,
}: {
  views: ViewTab[];
  activeId: string;
  onChange: (id: string) => void;
  onSaveView?: () => void;
  maxVisible?: number;
}) {
  let visible = views.slice(0, maxVisible);
  const active = views.find((v) => v.id === activeId);
  if (active && !visible.includes(active)) visible = [...visible.slice(0, -1), active];
  const overflow = views.filter((v) => !visible.includes(v));

  return (
    <div className="-mb-px flex items-end gap-1 overflow-x-auto" role="tablist" aria-label="Views">
      {visible.map((view) => (
        <button
          key={view.id}
          type="button"
          role="tab"
          aria-selected={view.id === activeId}
          onClick={() => onChange(view.id)}
          className={cn(
            "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors",
            view.id === activeId
              ? "border-primary font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {view.label}
        </button>
      ))}
      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="mb-1 shrink-0 text-muted-foreground">
              More ({overflow.length}) <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {overflow.map((view) => (
              <DropdownMenuItem key={view.id} onSelect={() => onChange(view.id)}>
                {view.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {onSaveView && (
        <Button
          variant="ghost"
          size="icon"
          className="mb-1 size-8 shrink-0 text-muted-foreground"
          aria-label="Save current view"
          onClick={onSaveView}
        >
          <Plus />
        </Button>
      )}
    </div>
  );
}
