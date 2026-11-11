import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { backend, type AssignmentRules } from "@/lib/backend-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { messageFromError, useIsAdmin, useSession } from "@/store";
import { keys } from "@/store/query";
import { previewOwner, ruleRowsProblem, rowsToRules, type RuleRow } from "./lead-assignment-rules";
import { SectionHeader } from "@/components/crm/section-layout";
import { useWorkspace } from "@/store/workspace-context";

const UNASSIGNED = "";
const SELECT_CLASS = "h-9 w-full rounded-md border bg-background px-3 text-sm";

const rowsFrom = (data: AssignmentRules): RuleRow[] =>
  data.rules.map((rule) => ({
    from: rule.minCr === null ? "" : String(rule.minCr),
    to: rule.maxCr === null ? "" : String(rule.maxCr),
    ownerId: rule.ownerId,
  }));

/** Settings → Lead assignment. Admins only; renders nothing for salespeople. */
export function LeadAssignmentPanel({ workspaceId }: { workspaceId: string }) {
  return useIsAdmin() ? <LeadAssignmentEditor workspaceId={workspaceId} /> : null;
}

function LeadAssignmentEditor({ workspaceId }: { workspaceId: string }) {
  const client = useQueryClient();
  const { users, userName } = useSession();
  const queryKey = keys.assignmentRules(workspaceId);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => backend.assignmentRules.get(signal),
  });
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [fallbackOwnerId, setFallbackOwnerId] = useState(UNASSIGNED);
  const [previewCr, setPreviewCr] = useState("3");
  useEffect(() => {
    if (!query.data) return;
    setRows(rowsFrom(query.data));
    setFallbackOwnerId(query.data.fallbackOwnerId ?? UNASSIGNED);
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      backend.assignmentRules.replace({
        rules: rowsToRules(rows),
        fallbackOwnerId: fallbackOwnerId || null,
      }),
    onSuccess: (data) => {
      client.setQueryData(queryKey, data);
      toast.success("Lead assignment rules saved.");
    },
    onError: (error) => toast.error(messageFromError(error)),
  });

  const problem = ruleRowsProblem(rows);
  const update = (index: number, patch: Partial<RuleRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const move = (index: number, by: -1 | 1) =>
    setRows((current) => {
      const next = [...current];
      [next[index], next[index + by]] = [next[index + by]!, next[index]!];
      return next;
    });

  const previewValue = Number(previewCr);
  const previewTarget =
    previewCr.trim() && Number.isFinite(previewValue) && !problem
      ? (previewOwner(rows, previewValue) ?? (fallbackOwnerId || null))
      : undefined;

  const saved = query.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users /> Lead assignment
        </CardTitle>
        <CardDescription>
          New leads from every source (manual, CSV import, website form) are given an owner by
          company revenue. Rules are checked top to bottom; the first match wins. Adding a lead with
          a chosen owner keeps that owner.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isError ? (
          <div className="space-y-2 text-sm">
            <p className="text-destructive">
              Couldn't load the assignment rules: {messageFromError(query.error)}
            </p>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        ) : !saved ? (
          <p className="text-sm text-muted-foreground">Loading assignment rules…</p>
        ) : (
          <>
            {!saved.fallbackOwnerAvailable && (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {saved.fallbackOwnerName ?? "The saved default owner"} is no longer active, so
                unmatched leads are currently unassigned.
              </p>
            )}
            <div className="space-y-2">
              {rows.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No rules yet: every new lead goes to the default owner below.
                </p>
              )}
              {rows.map((row, index) => (
                <div
                  key={index}
                  className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1.5fr_auto]"
                  data-testid="rule-row"
                >
                  <div className="space-y-1">
                    <Label htmlFor={`rule-${index}-from`} className="text-xs">
                      From (₹ Cr, exclusive, optional)
                    </Label>
                    <Input
                      id={`rule-${index}-from`}
                      inputMode="decimal"
                      value={row.from}
                      onChange={(e) => update(index, { from: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`rule-${index}-to`} className="text-xs">
                      Up to (₹ Cr, inclusive, optional)
                    </Label>
                    <Input
                      id={`rule-${index}-to`}
                      inputMode="decimal"
                      value={row.to}
                      onChange={(e) => update(index, { to: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`rule-${index}-owner`} className="text-xs">
                      Owner
                    </Label>
                    <select
                      id={`rule-${index}-owner`}
                      className={SELECT_CLASS}
                      value={row.ownerId}
                      onChange={(e) => update(index, { ownerId: e.target.value })}
                    >
                      <option value="">Choose…</option>
                      {users
                        .filter((user) => user.active || user.id === row.ownerId)
                        .map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Move rule ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Move rule ${index + 1} down`}
                      disabled={index === rows.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove rule ${index + 1}`}
                      onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setRows((current) => [...current, { from: "", to: "", ownerId: "" }])
                }
              >
                <Plus /> Add rule
              </Button>
            </div>
            <div className="max-w-sm space-y-1">
              <Label htmlFor="assignment-fallback" className="text-xs">
                When revenue is unknown or no rule matches
              </Label>
              <select
                id="assignment-fallback"
                className={SELECT_CLASS}
                value={fallbackOwnerId}
                onChange={(e) => setFallbackOwnerId(e.target.value)}
              >
                <option value={UNASSIGNED}>Unassigned (notify everyone for website leads)</option>
                {users
                  .filter((user) => user.active || user.id === fallbackOwnerId)
                  .map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>A lead with ₹</span>
              <Input
                aria-label="Preview revenue in crore"
                className="h-8 w-20"
                inputMode="decimal"
                value={previewCr}
                onChange={(e) => setPreviewCr(e.target.value)}
              />
              <span>
                Cr →{" "}
                <strong>
                  {previewTarget === undefined
                    ? "-"
                    : previewTarget === null
                      ? "Unassigned"
                      : userName(previewTarget)}
                </strong>
              </span>
            </div>
            {problem && (
              <p className="text-sm text-destructive" role="alert">
                {problem}
              </p>
            )}
            <div className="flex items-center gap-3 border-t pt-4">
              <p className="text-xs text-muted-foreground">Applies to new leads only.</p>
              <Button
                className="ml-auto"
                onClick={() => save.mutate()}
                disabled={Boolean(problem) || save.isPending}
              >
                Save rules
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Settings → Workspace → Lead assignment. */
export function AssignmentSection() {
  const { currentWorkspaceId } = useWorkspace();
  return (
    <>
      <SectionHeader
        title="Lead assignment"
        description="Who owns a new lead, by company revenue."
      />
      {currentWorkspaceId && <LeadAssignmentPanel workspaceId={currentWorkspaceId} />}
    </>
  );
}
