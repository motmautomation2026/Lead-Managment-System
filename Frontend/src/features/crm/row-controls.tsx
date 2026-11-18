import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { User } from "@/types";

/**
 * UX-2 inline edit: a quiet select that looks like text until hovered or focused. Only active
 * members are offered (the current owner is kept visible even when inactive).
 */
export function InlineOwner({
  value,
  users,
  onChange,
  label,
  disabled,
}: {
  value: { id: string; name: string } | null;
  users: User[];
  onChange: (ownerId: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const options = users.filter((u) => u.active || u.id === value?.id);
  return (
    <Select
      value={value?.id ?? ""}
      onValueChange={(id) => id !== value?.id && onChange(id)}
      disabled={disabled ?? false}
    >
      <SelectTrigger
        aria-label={label}
        className="h-7 max-w-full gap-1 border-transparent bg-transparent px-1.5 shadow-none hover:border-input focus-visible:border-input"
      >
        <SelectValue placeholder={<span className="text-muted-foreground">No owner</span>}>
          {value?.name}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((u) => (
          <SelectItem key={u.id} value={u.id}>
            {u.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The row's "…" menu (hover/kebab actions); items are DropdownMenuItems. */
export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label={label}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
