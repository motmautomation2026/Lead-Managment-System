import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { backend, type AdminUser } from "@/lib/backend-client";
import { keys, messageFromError } from "@/store";
import { PageHeader } from "@/app/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function AdminPage() {
  return (
    <div>
      <PageHeader title="Admin" description="Create, edit and deactivate salesperson accounts." />
      <div className="p-6">
        <UsersPanel />
      </div>
    </div>
  );
}

function UsersPanel() {
  const client = useQueryClient();
  const users = useQuery({
    queryKey: keys.adminUsers,
    queryFn: ({ signal }) => backend.admin.users.list(signal),
  });
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
      toast.success("Salesperson account created.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ name, email, password });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Create salesperson</CardTitle>
          <CardDescription>Creates a confirmed account with a permanent password.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <Field label="Full name">
              <Input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email">
              <Input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password (12+ characters)">
              <Input
                required
                minLength={12}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button className="w-full" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create account"}
            </Button>
          </form>
        </CardContent>
      </Card>
      <div className="space-y-3">
        <div>
          <h2 className="font-semibold">Salespeople</h2>
          <p className="text-sm text-muted-foreground">
            Deactivation preserves ownership and audit history.
          </p>
        </div>
        {users.isLoading && <p className="text-sm text-muted-foreground">Loading accounts…</p>}
        {users.isError && (
          <p className="text-sm text-destructive">{messageFromError(users.error)}</p>
        )}
        {users.data?.data.map((user) => (
          <UserEditor key={user.id} user={user} />
        ))}
      </div>
    </div>
  );
}

function UserEditor({ user }: { user: AdminUser }) {
  const client = useQueryClient();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: (input: { name?: string; email?: string; password?: string; active?: boolean }) =>
      backend.admin.users.update(user.id, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.adminUsers });
      setPassword("");
      toast.success("Account updated.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });
  return (
    <Card>
      <CardContent className="grid gap-3 p-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="New password (optional)">
          <Input
            type="password"
            minLength={12}
            value={password}
            placeholder="Retain current password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate({ name, email, ...(password ? { password } : {}) })}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant={user.active ? "destructive" : "outline"}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate({ active: !user.active })}
          >
            {user.active ? "Deactivate" : "Reactivate"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label className="mb-1.5 block text-xs">{label}</Label>
      {children}
    </div>
  );
}
