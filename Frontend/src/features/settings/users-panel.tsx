import { useState, type FormEvent, type ReactNode } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, UserCog } from "lucide-react";
import { toast } from "sonner";
import { backend, type AdminUser } from "@/lib/backend-client";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { keys, messageFromError } from "@/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorBlock } from "@/components/common/server-state";
import { DetailDrawer } from "@/components/crm/detail-drawer";
import { EmptyState } from "@/components/crm/empty-state";
import { SectionHeader } from "@/components/crm/section-layout";
import { StatusPill } from "@/components/crm/status-pill";
import { bookingUrlField } from "./booking-url";

/**
 * Settings → User accounts (global admins and super-admins; UX-1): sign-in accounts newest first (search, 50 per
 * page, Load more). Create in a dialog; a row opens the account in a drawer (edit, deactivate / reactivate).
 */
export function UsersPanel() {
  const [q, setQ] = useState("");
  const search = useDebouncedValue(q.trim(), 300);
  const query = search.length >= 2 ? search : undefined;
  const users = useInfiniteQuery({
    queryKey: [...keys.adminUsers, query ?? ""],
    queryFn: ({ pageParam, signal }) =>
      backend.admin.users.list({ cursor: pageParam, q: query }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = users.data?.pages.flatMap((p) => p.data) ?? [];
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rows.find((u) => u.id === openId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Search
            className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            aria-label="Search accounts"
            placeholder="Name or email"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Button id="users-create" onClick={() => setCreating(true)}>
          <Plus /> Create account
        </Button>
      </div>
      <p className="type-small text-muted-foreground">
        Deactivation keeps ownership and audit history. Add an account to a workspace in its Team
        section.
      </p>
      {users.isLoading ? (
        <div role="status" aria-label="Loading accounts" className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : users.isError ? (
        <ErrorBlock error={users.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={UserCog}
          title={query ? "No account matches" : "No accounts yet"}
          text={query ? "Try another name or email." : "Create the first salesperson account."}
          action={!query && <Button onClick={() => setCreating(true)}>Create account</Button>}
        />
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Accounts">
          {rows.map((user) => (
            <li key={user.id}>
              <button
                type="button"
                aria-label={`Open ${user.name}`}
                onClick={() => setOpenId(user.id)}
                className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-accent/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{user.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{user.email}</div>
                </div>
                <StatusPill tone={user.active ? "success" : "neutral"} dot>
                  {user.active ? "Active" : "Deactivated"}
                </StatusPill>
              </button>
            </li>
          ))}
        </ul>
      )}
      {users.hasNextPage && (
        <Button
          size="sm"
          variant="outline"
          disabled={users.isFetchingNextPage}
          onClick={() => void users.fetchNextPage()}
        >
          {users.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
      <CreateUserDialog open={creating} onOpenChange={setCreating} />
      <DetailDrawer
        open={open !== null}
        onOpenChange={(o) => !o && setOpenId(null)}
        title={open?.name ?? "Account"}
        description={open?.email}
      >
        {open && <UserEditor key={open.id} user={open} />}
      </DetailDrawer>
    </div>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const create = useMutation({
    mutationFn: backend.admin.users.create,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.adminUsers });
      setName("");
      setEmail("");
      setPassword("");
      onOpenChange(false);
      toast.success("Salesperson account created.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ name, email, password });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create salesperson</DialogTitle>
          <DialogDescription>A confirmed account with a permanent password.</DialogDescription>
        </DialogHeader>
        <form id="create-user" className="space-y-4" onSubmit={submit}>
          <Field label="Full name" id="create-user-name">
            <Input
              id="create-user-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Email" id="create-user-email">
            <Input
              id="create-user-email"
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password (12+ characters)" id="create-user-password">
            <Input
              id="create-user-password"
              required
              minLength={12}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-user" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserEditor({ user }: { user: AdminUser }) {
  const client = useQueryClient();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [password, setPassword] = useState("");
  const [bookingUrl, setBookingUrl] = useState(user.bookingUrl ?? "");
  const [confirmActive, setConfirmActive] = useState(false);
  const bookingCheck = bookingUrlField.safeParse(bookingUrl);
  const bookingError = bookingCheck.success ? null : bookingCheck.error.issues[0]?.message;
  const mutation = useMutation({
    mutationFn: (input: {
      name?: string;
      email?: string;
      password?: string;
      active?: boolean;
      bookingUrl?: string | null;
      emailAlertsEnabled?: boolean;
      emailDigestEnabled?: boolean;
    }) => backend.admin.users.update(user.id, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.adminUsers });
      setPassword("");
      setConfirmActive(false);
      toast.success("Account updated.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  const dirty =
    name !== user.name ||
    email !== user.email ||
    password !== "" ||
    bookingUrl !== (user.bookingUrl ?? "");
  return (
    <div className="space-y-4">
      <Field label="Name" id="user-name">
        <Input id="user-name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Email" id="user-email">
        <Input
          id="user-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="New password (optional)" id="user-password">
        <Input
          id="user-password"
          type="password"
          minLength={12}
          value={password}
          placeholder="Keep the current password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Field label="Booking link (optional)" id="user-booking">
        <Input
          id="user-booking"
          type="url"
          inputMode="url"
          placeholder="https://calendly.com/name"
          aria-invalid={Boolean(bookingError)}
          value={bookingUrl}
          onChange={(e) => setBookingUrl(e.target.value)}
        />
        {bookingError && <p className="mt-1 text-xs text-destructive">{bookingError}</p>}
      </Field>
      {/* LL-2 rule 3: the same email toggles the user has in Settings → My profile; each saves at once. */}
      {(
        [
          ["emailAlertsEnabled", "Email urgent alerts"],
          ["emailDigestEnabled", "Morning digest"],
        ] as const
      ).map(([field, label]) => (
        <div key={field} className="flex items-center justify-between gap-4">
          <Label htmlFor={`user-${field}`}>{label}</Label>
          <Switch
            id={`user-${field}`}
            checked={user[field] ?? true}
            disabled={mutation.isPending}
            onCheckedChange={(on) => mutation.mutate({ [field]: on })}
          />
        </div>
      ))}
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button
          disabled={!dirty || mutation.isPending || Boolean(bookingError)}
          onClick={() =>
            mutation.mutate({
              name,
              email,
              bookingUrl: bookingUrl.trim() || null,
              ...(password ? { password } : {}),
            })
          }
        >
          Save
        </Button>
        <Button
          variant={user.active ? "destructive" : "outline"}
          className="ml-auto"
          disabled={mutation.isPending}
          onClick={() => (user.active ? setConfirmActive(true) : mutation.mutate({ active: true }))}
        >
          {user.active ? "Deactivate" : "Reactivate"}
        </Button>
      </div>
      <ConfirmDialog
        open={confirmActive}
        onOpenChange={setConfirmActive}
        title={`Deactivate ${user.name}?`}
        description="They can no longer sign in. Their contacts, deals, tasks and history stay as they are; reactivate them at any time."
        confirmLabel="Deactivate"
        disabled={mutation.isPending}
        onConfirm={() => mutation.mutate({ active: false })}
      />
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 block text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Settings → Admin → User accounts (global admins and super-admins). */
export function UsersSection() {
  return (
    <>
      <SectionHeader
        title="User accounts"
        description="Create, edit and deactivate sign-in accounts."
      />
      <UsersPanel />
    </>
  );
}
