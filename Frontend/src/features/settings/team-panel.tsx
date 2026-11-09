import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { backend, type TeamMember, type WorkspaceRole } from "@/lib/backend-client";
import { keys, messageFromError } from "@/store";
import { useWorkspace } from "@/store/workspace-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import { EmptyState } from "@/components/crm/empty-state";
import { Users } from "lucide-react";

const SELECT_CLASS = "h-9 w-full rounded-md border bg-background px-3 text-sm";
const ROLE_LABEL: Record<WorkspaceRole, string> = { admin: "Admin", salesperson: "Salesperson" };

/**
 * Settings → Team (E4b rule 9, admins of this workspace): members with their role here; add an existing
 * user by email, change a role, remove. The backend blocks removing someone who still owns work and the
 * last admin, with the reason.
 */
export function TeamPanel() {
  const client = useQueryClient();
  const { currentWorkspace, currentWorkspaceId } = useWorkspace();
  const members = useQuery({
    queryKey: keys.team(currentWorkspaceId),
    queryFn: ({ signal }) => backend.team.list(signal),
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("salesperson");
  const [removing, setRemoving] = useState<TeamMember | null>(null);

  const done = (message: string) => (result: { data: TeamMember[] }) => {
    client.setQueryData(keys.team(currentWorkspaceId), result);
    // Pickers read the directory; roles change what the user can do here.
    void client.invalidateQueries({ queryKey: keys.profiles(currentWorkspaceId) });
    void client.invalidateQueries({ queryKey: keys.workspaces });
    toast.success(message);
  };
  const onError = (error: unknown) => toast.error(messageFromError(error));
  const add = useMutation({
    mutationFn: (input: { email: string; role: WorkspaceRole }) => backend.team.add(input),
    onSuccess: (result) => {
      done("Member added.")(result);
      setEmail("");
    },
    onError,
  });
  const setMemberRole = useMutation({
    mutationFn: ({ userId, next }: { userId: string; next: WorkspaceRole }) =>
      backend.team.setRole(userId, next),
    onSuccess: done("Role changed."),
    onError,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => backend.team.remove(userId),
    onSuccess: (result) => {
      done("Member removed.")(result);
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
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Add a member</CardTitle>
          <CardDescription>
            An existing user joins {currentWorkspace?.name ?? "this workspace"}. New accounts are
            created in Users.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={submit}>
            <div className="space-y-1">
              <Label htmlFor="team-email">Email</Label>
              <Input
                id="team-email"
                type="email"
                required
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
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Only members can open this workspace. Reassign someone&rsquo;s contacts, deals and tasks
            before removing them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {members.isLoading ? (
            <LoadingBlock />
          ) : members.isError ? (
            <ErrorBlock error={members.error} />
          ) : !members.data?.data.length ? (
            <EmptyState icon={Users} title="No members" text="Add the first member on the left." />
          ) : (
            <ul className="divide-y">
              {members.data.data.map((member) => (
                <li
                  key={member.userId}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {member.name}
                      {!member.active && (
                        <span className="ml-2 text-xs text-muted-foreground">(deactivated)</span>
                      )}
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
        </CardContent>
      </Card>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? "member"}?`}
        description="They will no longer be able to open this workspace. Their account stays."
        confirmLabel="Remove"
        disabled={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.userId)}
      />
    </div>
  );
}
