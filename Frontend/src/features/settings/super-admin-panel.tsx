import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2 } from "lucide-react";
import { backend, type WorkspaceRole } from "@/lib/backend-client";
import { keys, messageFromError } from "@/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import { EmptyState } from "@/components/crm/empty-state";
import { SectionHeader } from "@/components/crm/section-layout";

const CELL_SELECT = "h-8 w-full min-w-28 rounded-md border bg-background px-2 text-xs";
const NONE = "";

/**
 * Settings → All workspaces (E4b rule 10, super-admins only): every workspace × active user with the role,
 * paged by name; change a cell to add / change / remove a membership; create a workspace (you become its admin).
 */
export function SuperAdminPanel() {
  const client = useQueryClient();
  const [q, setQ] = useState("");
  const search = q.trim().length >= 2 ? q.trim() : "";
  const pages = useInfiniteQuery({
    queryKey: keys.memberships(search),
    queryFn: ({ pageParam, signal }) =>
      backend.superAdmin.memberships({ cursor: pageParam, q: search || undefined }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["memberships"] });
    void client.invalidateQueries({ queryKey: keys.workspaces });
  };
  const setMembership = useMutation({
    mutationFn: (input: { workspaceId: string; userId: string; role: WorkspaceRole | null }) =>
      backend.superAdmin.setMembership(input),
    onSuccess: () => {
      refresh();
      toast.success("Membership saved.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: (value: string) => backend.workspaces.create(value),
    onSuccess: (workspace) => {
      refresh();
      setName("");
      toast.success(`Workspace "${workspace.name}" created. You are its admin.`);
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(name.trim());
  };

  const workspaces = pages.data?.pages[0]?.workspaces ?? [];
  const users = pages.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Create a workspace</CardTitle>
          <CardDescription>
            You become its admin; add the client&rsquo;s users below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={submit}>
            <div className="flex-1 space-y-1">
              <Label htmlFor="new-workspace-name">Name</Label>
              <Input
                id="new-workspace-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              Create workspace
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspaces and users</CardTitle>
          <CardDescription>
            Each cell is the user&rsquo;s role in that workspace. Super-admins open every workspace
            anyway.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="max-w-sm space-y-1">
            <Label htmlFor="membership-search">Search users</Label>
            <Input
              id="membership-search"
              placeholder="Name or email (2+ letters)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {pages.isLoading ? (
            <LoadingBlock />
          ) : pages.isError ? (
            <ErrorBlock error={pages.error} />
          ) : !users.length ? (
            <EmptyState
              icon={Building2}
              title="No users"
              text={search ? "No active user matches." : "There are no active users."}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-medium">
                      User
                    </th>
                    {workspaces.map((workspace) => (
                      <th key={workspace.id} scope="col" className="px-2 py-2 font-medium">
                        {workspace.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id} className="border-b last:border-0">
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        <div className="font-medium">
                          {user.name}
                          {user.isSuperAdmin && (
                            <span className="ml-2 text-xs text-muted-foreground">super-admin</span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">{user.email}</div>
                      </th>
                      {workspaces.map((workspace) => (
                        <td key={workspace.id} className="px-2 py-2">
                          <select
                            aria-label={`${user.name} in ${workspace.name}`}
                            className={CELL_SELECT}
                            value={user.roles[workspace.id] ?? NONE}
                            disabled={setMembership.isPending}
                            onChange={(e) =>
                              setMembership.mutate({
                                workspaceId: workspace.id,
                                userId: user.id,
                                role: (e.target.value || null) as WorkspaceRole | null,
                              })
                            }
                          >
                            <option value={NONE}>Not a member</option>
                            <option value="salesperson">Salesperson</option>
                            <option value="admin">Admin</option>
                          </select>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pages.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
            >
              Load more
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Settings → Admin → All workspaces (super-admins). */
export function WorkspacesSection() {
  return (
    <>
      <SectionHeader
        title="All workspaces"
        description="Every workspace × user, with the role in each."
      />
      <SuperAdminPanel />
    </>
  );
}
