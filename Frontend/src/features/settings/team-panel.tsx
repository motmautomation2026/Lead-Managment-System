import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search, Users } from "lucide-react";
import { backend, type TeamMember, type WorkspaceRole } from "@/lib/backend-client";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { keys, messageFromError } from "@/store";
import { useCursorList } from "@/store/server-hooks";
import { useWorkspace } from "@/store/workspace-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorBlock } from "@/components/common/server-state";
import { EmptyState } from "@/components/crm/empty-state";
import { SectionHeader } from "@/components/crm/section-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/crm/status-pill";

const SELECT_CLASS = "h-9 w-full rounded-md border bg-background px-3 text-sm";
const ROLE_LABEL: Record<WorkspaceRole, string> = { admin: "Admin", salesperson: "Salesperson" };

/**
 * Settings → Team (E4b rule 9, admins of this workspace; UX-1): add an existing user by email at the top, then the
 * members by name (search, 50 per page, Load more) with their role here; change a role, remove (confirm). The
 * backend blocks removing someone who still owns work and the last admin, with the reason.
 */
export function TeamPanel() {
  const client = useQueryClient();
  const { currentWorkspace, currentWorkspaceId } = useWorkspace();
  const [q, setQ] = useState("");
  const search = useDebouncedValue(q.trim(), 300);
  const query = search.length >= 2 ? search : undefined;
  const members = useCursorList([...keys.team(currentWorkspaceId), query ?? ""], (cursor, signal) =>
    backend.team.list({ cursor, q: query }, signal),
  );
  const rows = members.data?.pages.flatMap((p) => p.data) ?? [];
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("salesperson");
  const [removing, setRemoving] = useState<TeamMember | null>(null);

  const done = (message: string) => {
    void client.invalidateQueries({ queryKey: keys.team(currentWorkspaceId) });
    // Pickers read the directory; roles change what the user can do here.
    void client.invalidateQueries({ queryKey: keys.profiles(currentWorkspaceId) });
    void client.invalidateQueries({ queryKey: keys.workspaces });
    toast.success(message);
  };
  const onError = (error: unknown) => toast.error(messageFromError(error));
  const add = useMutation({
    mutationFn: (input: { email: string; role: WorkspaceRole }) => backend.team.add(input),
    onSuccess: () => {
      done("Member added.");
      setEmail("");
    },
    onError,
  });
  const setMemberRole = useMutation({
    mutationFn: ({ userId, next }: { userId: string; next: WorkspaceRole }) =>
      backend.team.setRole(userId, next),
    onSuccess: () => done("Role changed."),
    onError,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => backend.team.remove(userId),
    onSuccess: () => {
      done("Member removed.");
      setRemoving(null);
    },
    onError: (error) => {
      onError(error);
      setRemoving(null);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate({ email: email.trim(), role });
  };

  return (
    <div className="space-y-6">
      <form
        className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end"
        onSubmit={submit}
        aria-label="Add a member"
      >
        <div className="space-y-1">
          <Label htmlFor="team-add">Add an existing user by email</Label>
          <Input
            id="team-add"
            type="email"
            required
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="team-role">Role in this workspace</Label>
          <select
            id="team-role"
            className={SELECT_CLASS}
            value={role}
            onChange={(e) => setRole(e.target.value as WorkspaceRole)}
          >
            <option value="salesperson">Salesperson</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <Button type="submit" disabled={add.isPending || !email.trim()}>
          Add member
        </Button>
        <p className="type-small text-muted-foreground sm:col-span-3">
          They join {currentWorkspace?.name ?? "this workspace"}. New sign-in accounts are created
          in User accounts.
        </p>
      </form>

      <section aria-labelledby="team-members" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="team-members" className="type-section-title">
              Members
            </h3>
            <p className="type-small text-muted-foreground">
              Only members can open this workspace. Reassign someone&rsquo;s contacts, deals and
              tasks before removing them.
            </p>
          </div>
          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
              aria-hidden
            />
            <Input
              aria-label="Search members"
              placeholder="Name or email"
              className="pl-8"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
        {members.isLoading ? (
          <div role="status" aria-label="Loading members" className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : members.isError ? (
          <ErrorBlock error={members.error} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title={query ? "No member matches" : "No members"}
            text={query ? "Try another name or email." : "Add the first member above."}
          />
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="Members">
            {rows.map((member) => (
              <li
                key={member.userId}
                className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 truncate text-sm font-medium">
                    {member.name}
                    {!member.active && <StatusPill>Deactivated</StatusPill>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{member.email}</div>
                </div>
                <select
                  aria-label={`Role of ${member.name}`}
                  className={`${SELECT_CLASS} sm:w-40`}
                  value={member.role}
                  disabled={setMemberRole.isPending}
                  onChange={(e) =>
                    setMemberRole.mutate({
                      userId: member.userId,
                      next: e.target.value as WorkspaceRole,
                    })
                  }
                >
                  {(Object.keys(ROLE_LABEL) as WorkspaceRole[]).map((value) => (
                    <option key={value} value={value}>
                      {ROLE_LABEL[value]}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRemoving(member)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {members.hasNextPage && (
          <Button
            size="sm"
            variant="outline"
            disabled={members.isFetchingNextPage}
            onClick={() => void members.fetchNextPage()}
          >
            {members.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
      </section>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? "member"}?`}
        description="They can no longer open this workspace. Their account, and everything they did here, stays."
        confirmLabel="Remove"
        disabled={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.userId)}
      />
    </div>
  );
}

/** Settings → Workspace → Team. */
export function TeamSection() {
  return (
    <>
      <SectionHeader title="Team" description="Who can open this workspace, and their role here." />
      <TeamPanel />
    </>
  );
}
