import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Building2, Handshake, Moon, Plus, Search, User } from "lucide-react";
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Money } from "@/components/crm/money";
import { NAV_GROUPS } from "@/app/nav";
import { useTheme } from "@/app/theme-context";
import { messageFromError, useGlobalSearch } from "@/store";
import { SEARCH_MIN_CHARS } from "@/store/server-hooks";
import { label } from "@/lib/labels";
import { readRecents, type RecentType } from "@/lib/recent-records";
import { useWorkspace } from "@/store/workspace-context";

const RECENT_ICONS: Record<RecentType, ReactNode> = {
  contact: <User />,
  company: <Building2 />,
  deal: <Handshake />,
};

/** Shown with an empty query, after the recent records. */
const QUICK_ACTIONS = new Set([
  "create-contact",
  "create-company",
  "create-deal",
  "go-/contacts",
  "go-/companies",
  "go-/deals",
  "go-/tasks",
]);

/**
 * ⌘K palette: server-side search (contacts, companies, deals; top 5 each, then "See all
 * results" → /search) plus actions. Empty query: the viewer's recent records, then quick
 * actions. Results come from GET /search, so cmdk's own filtering is off.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onCreateContact,
  onCreateCompany,
  onCreateDeal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateContact: () => void;
  onCreateCompany: () => void;
  onCreateDeal: () => void;
}) {
  const [input, setInput] = useState("");
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  const search = useGlobalSearch(open ? input : "");
  const term = input.trim();
  const { currentWorkspaceId } = useWorkspace();
  // Read on every open (records opened since then are new); per browser + workspace.
  const recents = useMemo(
    () => (open ? readRecents(currentWorkspaceId) : []),
    [open, currentWorkspaceId],
  );

  const close = (then: () => void) => {
    onOpenChange(false);
    setInput("");
    then();
  };

  const actions: Array<{ id: string; label: string; icon: ReactNode; run: () => void }> = [
    { id: "create-contact", label: "Create contact", icon: <Plus />, run: onCreateContact },
    { id: "create-company", label: "Create company", icon: <Plus />, run: onCreateCompany },
    { id: "create-deal", label: "Create deal", icon: <Plus />, run: onCreateDeal },
    ...NAV_GROUPS.flatMap((g) => g.items).map((item) => ({
      id: `go-${item.to}`,
      label: `Go to ${item.label}`,
      icon: <item.icon />,
      run: () => void navigate({ to: item.to }),
    })),
    {
      id: "toggle-theme",
      label: `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`,
      icon: <Moon />,
      run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
    },
  ];
  const matchingActions = term
    ? actions.filter((a) => a.label.toLowerCase().includes(term.toLowerCase()))
    : actions.filter((a) => QUICK_ACTIONS.has(a.id));

  const data = search.enabled && search.query === term ? search.data : undefined;
  const hits =
    (data?.contacts.length ?? 0) + (data?.companies.length ?? 0) + (data?.deals.length ?? 0);
  const searchable = term.length >= SEARCH_MIN_CHARS;

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setInput("");
        onOpenChange(o);
      }}
      commandProps={{ shouldFilter: false, label: "Search and commands" }}
    >
      <DialogTitle className="sr-only">Search</DialogTitle>
      <DialogDescription className="sr-only">
        Search contacts, companies and deals, or run an action.
      </DialogDescription>
      <CommandInput
        value={input}
        onValueChange={setInput}
        placeholder="Search contacts, companies, deals or type a command…"
      />
      <CommandList className="max-h-[min(420px,60dvh)]">
        <div role="status" aria-live="polite" className="empty:hidden">
          {term.length === 1 && <Hint>Type at least {SEARCH_MIN_CHARS} characters to search.</Hint>}
          {searchable && search.isSearching && !data && <Hint>Searching…</Hint>}
          {searchable && search.isError && (
            <Hint>Search failed: {messageFromError(search.error)}</Hint>
          )}
          {searchable && data && hits === 0 && matchingActions.length === 0 && (
            <Hint>No results for &ldquo;{term}&rdquo;.</Hint>
          )}
        </div>

        {!term && recents.length > 0 && (
          <CommandGroup heading="Recent">
            {recents.map((r) => (
              <CommandItem
                key={`${r.type}-${r.id}`}
                value={`recent-${r.type}-${r.id}`}
                onSelect={() =>
                  close(() =>
                    r.type === "contact"
                      ? void navigate({ to: "/contacts/$contactId", params: { contactId: r.id } })
                      : r.type === "company"
                        ? void navigate({
                            to: "/companies/$companyId",
                            params: { companyId: r.id },
                          })
                        : void navigate({ to: "/deals/$dealId", params: { dealId: r.id } }),
                  )
                }
              >
                {RECENT_ICONS[r.type]}
                <Result title={r.label} meta={[label(r.type)]} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {data && data.contacts.length > 0 && (
          <CommandGroup heading="Contacts">
            {data.contacts.map((c) => (
              <CommandItem
                key={c.id}
                value={`contact-${c.id}`}
                onSelect={() =>
                  close(
                    () =>
                      void navigate({ to: "/contacts/$contactId", params: { contactId: c.id } }),
                  )
                }
              >
                <User />
                <Result
                  title={c.name || c.email || "Unnamed contact"}
                  meta={[c.company, c.email]}
                />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {data && data.companies.length > 0 && (
          <CommandGroup heading="Companies">
            {data.companies.map((c) => (
              <CommandItem
                key={c.id}
                value={`company-${c.id}`}
                onSelect={() =>
                  close(
                    () =>
                      void navigate({ to: "/companies/$companyId", params: { companyId: c.id } }),
                  )
                }
              >
                <Building2 />
                <Result title={c.name} meta={[c.domain]} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {data && data.deals.length > 0 && (
          <CommandGroup heading="Deals">
            {data.deals.map((d) => (
              <CommandItem
                key={d.id}
                value={`deal-${d.id}`}
                onSelect={() =>
                  close(() => void navigate({ to: "/deals/$dealId", params: { dealId: d.id } }))
                }
              >
                <Handshake />
                <Result title={d.name} meta={[label(d.stage), d.company?.name]} />
                {d.amount != null && (
                  <Money
                    amount={d.amount}
                    currency={d.currency}
                    compact
                    className="ml-auto text-xs"
                  />
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {matchingActions.length > 0 && (
          <CommandGroup heading="Actions">
            {matchingActions.map((a) => (
              <CommandItem key={a.id} value={a.id} onSelect={() => close(a.run)}>
                {a.icon}
                {a.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* After the results arrive, so cmdk keeps highlighting the first result. */}
        {searchable && (data || search.isError) && (
          <CommandGroup>
            <CommandItem
              value="see-all-results"
              onSelect={() => close(() => void navigate({ to: "/search", search: { q: term } }))}
            >
              <Search />
              See all results for &ldquo;{term}&rdquo;
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="px-4 py-3 text-sm text-muted-foreground">{children}</p>;
}

function Result({ title, meta }: { title: string; meta: Array<string | null | undefined> }) {
  const sub = meta.filter(Boolean).join(" · ");
  return (
    <span className="min-w-0">
      <span className="block truncate">{title}</span>
      {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
    </span>
  );
}
