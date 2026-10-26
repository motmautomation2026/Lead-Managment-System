import { useState } from "react";
import { toast } from "sonner";
import { Building2, ChevronDown, Plus, X } from "lucide-react";
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
import { backend } from "@/lib/backend-client";
import { cn } from "@/lib/utils";
import { messageFromError, useCompanySearch, useCreateCompany } from "@/store";
import { SEARCH_MIN_CHARS } from "@/store/server-hooks";
import type { IdName } from "@/types";
import { existingCompanyId } from "./company-helpers";

/**
 * Searchable company combobox over `GET /companies?q=` (debounced, from 2 characters,
 * cmdk keyboard: ↑/↓, Enter, Esc). `variant="chip"` matches FilterBar chips (list filters);
 * `variant="field"` is a full-width form control. `allowCreate` adds "Create company '<text>'"
 * (POST /companies; any CRM user may create); a 409 picks the existing company instead.
 */
export function CompanyPicker({
  value,
  onChange,
  allowCreate = false,
  excludeIds = [],
  variant = "field",
  placeholder = "Choose a company",
  label = "Company",
  disabled,
}: {
  value: IdName | null;
  onChange: (company: IdName | null) => void;
  allowCreate?: boolean;
  excludeIds?: string[];
  variant?: "chip" | "field";
  placeholder?: string;
  label?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const term = input.trim();
  const search = useCompanySearch(input);
  const create = useCreateCompany();
  const settled = search.data && !search.isFetching;
  const results = (search.data?.data ?? []).filter((c) => !excludeIds.includes(c.id));
  const exact = results.some((c) => c.name.toLowerCase() === term.toLowerCase());
  const canCreate = allowCreate && term.length >= SEARCH_MIN_CHARS && !exact;

  const pick = (company: IdName | null) => {
    onChange(company);
    setOpen(false);
    setInput("");
  };

  const createCompany = async () => {
    try {
      const company = await create.mutateAsync({ name: term });
      toast.success(`Company "${company.name}" created`);
      pick({ id: company.id, name: company.name });
    } catch (error) {
      const existing = existingCompanyId(error);
      if (!existing) return void toast.error(messageFromError(error));
      const company = await backend.companies.get(existing);
      toast.info(`"${company.name}" already exists; picked it.`);
      pick({ id: company.id, name: company.name });
    }
  };

  return (
    <div className={cn("flex items-center gap-1", variant === "field" && "w-full")}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size={variant === "chip" ? "sm" : "default"}
            disabled={disabled}
            aria-label={variant === "chip" ? `${label} filter` : label}
            className={cn(
              variant === "chip"
                ? cn("max-w-64", value && "border-primary/40 bg-accent text-accent-foreground")
                : "w-full justify-between font-normal",
            )}
          >
            <span
              className={cn("truncate", variant === "field" && !value && "text-muted-foreground")}
            >
              {variant === "chip"
                ? value
                  ? `${label}: ${value.name}`
                  : label
                : (value?.name ?? placeholder)}
            </span>
            <ChevronDown className="opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <Command shouldFilter={false} label="Companies">
            <CommandInput
              value={input}
              onValueChange={setInput}
              placeholder="Search companies…"
              aria-label="Search companies"
            />
            <CommandList className="max-h-64">
              {term.length < SEARCH_MIN_CHARS ? (
                <div className="px-3 py-4 type-small text-muted-foreground">
                  Type at least {SEARCH_MIN_CHARS} characters.
                </div>
              ) : search.isError ? (
                <div className="px-3 py-4 type-small text-destructive">
                  {messageFromError(search.error)}
                </div>
              ) : !settled && results.length === 0 ? (
                <div className="px-3 py-4 type-small text-muted-foreground">Searching…</div>
              ) : (
                !canCreate && <CommandEmpty>No companies match.</CommandEmpty>
              )}
              {results.length > 0 && term.length >= SEARCH_MIN_CHARS && (
                <CommandGroup>
                  {results.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={c.id}
                      onSelect={() => pick({ id: c.id, name: c.name })}
                    >
                      <Building2 />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      {c.domain && (
                        <span className="truncate type-small text-muted-foreground">
                          {c.domain}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {canCreate && (
                <CommandGroup>
                  <CommandItem
                    value="__create"
                    disabled={create.isPending}
                    onSelect={() => void createCompany()}
                  >
                    <Plus />
                    <span className="truncate">Create company &ldquo;{term}&rdquo;</span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && variant === "chip" && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Clear ${label.toLowerCase()} filter`}
          onClick={() => onChange(null)}
        >
          <X />
        </Button>
      )}
    </div>
  );
}
