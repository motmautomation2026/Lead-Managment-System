import { useState } from "react";
import { ChevronDown, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { messageFromError, useContactSearch } from "@/store";
import { SEARCH_MIN_CHARS } from "@/store/server-hooks";
import type { IdName } from "@/types";

/**
 * Searchable contact combobox over `GET /contacts?q=` (debounced, from 2 characters, top 8,
 * cmdk keyboard: ↑/↓, Enter, Esc) — the same feel as CompanyPicker. `companyId` limits it to
 * that company's contacts and lists them before anything is typed.
 */
export function ContactPicker({
  value,
  onChange,
  companyId,
  placeholder = "Choose a contact",
  label = "Contact",
  id,
  disabled,
  invalid,
}: {
  value: IdName | null;
  onChange: (contact: IdName | null) => void;
  companyId?: string | undefined;
  placeholder?: string;
  label?: string;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const term = input.trim();
  const search = useContactSearch(input, companyId);
  const results = search.data?.data ?? [];
  const needsTyping = !companyId && term.length < SEARCH_MIN_CHARS;

  const pick = (contact: IdName) => {
    onChange(contact);
    setOpen(false);
    setInput("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={label}
          aria-invalid={invalid}
          className="w-full justify-between font-normal"
        >
          <span className={value ? "truncate" : "truncate text-muted-foreground"}>
            {value?.name || placeholder}
          </span>
          <ChevronDown className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        <Command shouldFilter={false} label="Contacts">
          <CommandInput
            value={input}
            onValueChange={setInput}
            placeholder="Search contacts…"
            aria-label="Search contacts"
          />
          <CommandList className="max-h-64">
            {needsTyping ? (
              <div className="px-3 py-4 type-small text-muted-foreground">
                Type at least {SEARCH_MIN_CHARS} characters.
              </div>
            ) : search.isError ? (
              <div className="px-3 py-4 type-small text-destructive">
                {messageFromError(search.error)}
              </div>
            ) : search.isFetching && results.length === 0 ? (
              <div className="px-3 py-4 type-small text-muted-foreground">Searching…</div>
            ) : (
              <CommandEmpty>
                {companyId && !term ? "This company has no contacts yet." : "No contacts match."}
              </CommandEmpty>
            )}
            {!needsTyping && results.length > 0 && (
              <CommandGroup>
                {results.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={c.id}
                    onSelect={() =>
                      pick({ id: c.id, name: c.name || c.email || "Unnamed contact" })
                    }
                  >
                    <User />
                    <span className="min-w-0 flex-1 truncate">{c.name || "Unnamed contact"}</span>
                    <span className="truncate type-small text-muted-foreground">
                      {c.company?.name ?? c.email ?? ""}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
