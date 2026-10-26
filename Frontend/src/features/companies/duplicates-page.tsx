import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ArrowRight, Building2, CopyCheck, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { StatusBadge } from "@/components/common/status-badge";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import { PageHeader } from "@/components/crm/page-header";
import { ViewTabs } from "@/components/crm/view-tabs";
import { FilterBar } from "@/components/crm/filter-bar";
import type { FilterDef, FilterValues } from "@/components/crm/filter-model";
import { EmptyState } from "@/components/crm/empty-state";
import { RelativeTime } from "@/components/crm/relative-time";
import { useListUrlState } from "@/lib/use-list-url-state";
import { cn } from "@/lib/utils";
import {
  messageFromError,
  useCompanyDuplicates,
  useCompanyDuplicatesCount,
  useDismissDuplicate,
  useIsAdmin,
  useMergeDuplicate,
  useRelinkDuplicate,
} from "@/store";
import type {
  CompanyDuplicate,
  DuplicateCompany,
  DuplicateListParams,
  DuplicateReason,
  DuplicateStatus,
  IdName,
} from "@/types";
import { CompanyPicker } from "./company-picker";
import { REASON_LABEL, STATUSES, duplicatesSearchSchema } from "./duplicates-search";

/** Admin duplicate review: company pairs (merge / not a duplicate) and contact-level mismatches. */
export function DuplicatesPage() {
  const isAdmin = useIsAdmin();
  if (!isAdmin)
    return (
      <EmptyState
        icon={CopyCheck}
        title="Admins only"
        text="Only administrators can review duplicate companies."
        action={
          <Button asChild variant="outline">
            <Link to="/companies">Back to companies</Link>
          </Button>
        }
      />
    );
  return <DuplicateReview />;
}

function DuplicateReview() {
  const [state, set] = useListUrlState(duplicatesSearchSchema);
  const filters: DuplicateListParams = { reason: state.reason, status: state.status };
  const params: DuplicateListParams = { ...filters, kind: state.kind };
  const list = useCompanyDuplicates(params);
  const all = useCompanyDuplicatesCount(filters);
  const pairs = useCompanyDuplicatesCount({ ...filters, kind: "pair" });
  const contacts = useCompanyDuplicatesCount({ ...filters, kind: "contact" });
  // Optimistic removal: rows being resolved leave the list at once; a failure brings them back.
  const [hidden, setHidden] = useState<string[]>([]);
  const rows = useMemo(
    () => (list.data?.pages.flatMap((p) => p.data) ?? []).filter((r) => !hidden.includes(r.id)),
    [list.data, hidden],
  );
  const act = async (id: string, work: () => Promise<unknown>, success: string) => {
    setHidden((h) => [...h, id]);
    try {
      await work();
      toast.success(success);
    } catch (error) {
      setHidden((h) => h.filter((x) => x !== id));
      toast.error(messageFromError(error));
    }
  };

  const tabLabel = (text: string, n: number | undefined) =>
    n === undefined ? text : `${text} (${n})`;
  const views = [
    { id: "all", label: tabLabel("All", all.data?.count) },
    { id: "pair", label: tabLabel("Company pairs", pairs.data?.count) },
    { id: "contact", label: tabLabel("Contact mismatches", contacts.data?.count) },
  ];
  const filterDefs: FilterDef[] = [
    {
      id: "reason",
      label: "Reason",
      type: "multi",
      options: (Object.keys(REASON_LABEL) as DuplicateReason[]).map((value) => ({
        value,
        label: REASON_LABEL[value],
      })),
    },
    {
      id: "status",
      label: "Status",
      type: "multi",
      options: STATUSES.map((value) => ({
        value,
        label: value === "open" ? "Open" : value === "merged" ? "Merged" : "Dismissed",
      })),
    },
  ];
  const values: FilterValues = { reason: state.reason, status: state.status };
  const resolvedView = Boolean(state.status?.length && !state.status.includes("open"));

  return (
    <div className="pb-24">
      <PageHeader
        title="Duplicate companies"
        count={all.data?.count ?? null}
        description="Suggestions from automatic company linking. Nothing is merged on a guess: you decide."
        tabs={
          <ViewTabs
            views={views}
            activeId={state.kind ?? "all"}
            onChange={(id) =>
              void set({ kind: id === "all" ? undefined : (id as "pair" | "contact") })
            }
          />
        }
      />
      <div className="space-y-3 px-4 pt-4 sm:px-6">
        <FilterBar
          filters={filterDefs}
          values={values}
          onChange={(v) =>
            void set({
              reason: (v["reason"] as DuplicateReason[] | undefined)?.length
                ? (v["reason"] as DuplicateReason[])
                : undefined,
              status: (v["status"] as DuplicateStatus[] | undefined)?.length
                ? (v["status"] as DuplicateStatus[])
                : undefined,
            })
          }
        />
        {list.isLoading ? (
          <LoadingBlock label="Loading suggestions…" />
        ) : list.error ? (
          <ErrorBlock error={list.error} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={CopyCheck}
            title={resolvedView ? "No resolved suggestions" : "Nothing to review"}
            text={
              resolvedView
                ? "Merged and dismissed suggestions show up here."
                : "Every duplicate suggestion has been handled."
            }
          />
        ) : (
          <ul className="space-y-3" aria-label="Duplicate suggestions">
            {rows.map((row) => (
              <li key={row.id}>
                {row.kind === "pair" && row.companyB ? (
                  <PairRow row={row} b={row.companyB} act={act} />
                ) : (
                  <ContactRow row={row} act={act} />
                )}
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              size="sm"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

type Act = (id: string, work: () => Promise<unknown>, success: string) => Promise<void>;

function RowMeta({ row }: { row: CompanyDuplicate }) {
  return (
    <div className="flex flex-wrap items-center gap-2 type-small text-muted-foreground">
      <span className="font-medium text-foreground">{REASON_LABEL[row.reason]}</span>
      {row.score !== null && <span>· similarity {Math.round(row.score * 100)}%</span>}
      <span>
        · <RelativeTime value={row.createdAt} />
      </span>
      {row.status !== "open" && (
        <>
          <StatusBadge value={row.status} />
          {row.resolvedAt && <RelativeTime value={row.resolvedAt} />}
        </>
      )}
    </div>
  );
}

function CompanyCard({ company, highlight }: { company: DuplicateCompany; highlight?: boolean }) {
  return (
    <div className={cn("min-w-0 rounded-lg border p-3", highlight && "border-primary bg-accent")}>
      <div className="flex items-center gap-2">
        <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {company.merged ? (
          <span className="truncate type-body font-semibold">{company.name}</span>
        ) : (
          <Link
            to="/companies/$companyId"
            params={{ companyId: company.id }}
            className="truncate type-body font-semibold hover:underline"
          >
            {company.name}
          </Link>
        )}
        {company.merged && <StatusBadge value="merged" />}
      </div>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 type-small">
        <dt className="text-muted-foreground">Domain</dt>
        <dd className="truncate">{company.domain ?? "–"}</dd>
        <dt className="text-muted-foreground">Industry</dt>
        <dd className="truncate">{company.industry ?? "–"}</dd>
        <dt className="text-muted-foreground">Contacts</dt>
        <dd className="num">{company.contactCount}</dd>
        <dt className="text-muted-foreground">Open deals</dt>
        <dd className="num">{company.openDealCount}</dd>
      </dl>
    </div>
  );
}

function PairRow({ row, b, act }: { row: CompanyDuplicate; b: DuplicateCompany; act: Act }) {
  const merge = useMergeDuplicate();
  const dismiss = useDismissDuplicate();
  const [mergeOpen, setMergeOpen] = useState(false);
  const [keepId, setKeepId] = useState(row.companyA.id);
  const [dismissOpen, setDismissOpen] = useState(false);
  const a = row.companyA;
  const kept = keepId === a.id ? a : b;
  const source = keepId === a.id ? b : a;
  const open = row.status === "open";

  return (
    <Card className="space-y-3 p-4">
      <RowMeta row={row} />
      <div className="grid gap-3 sm:grid-cols-2">
        <CompanyCard company={a} />
        <CompanyCard company={b} />
      </div>
      {open && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setDismissOpen(true)}>
            Not a duplicate
          </Button>
          <Button size="sm" onClick={() => setMergeOpen(true)}>
            Merge…
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={dismissOpen}
        onOpenChange={setDismissOpen}
        title="Not a duplicate?"
        description={`“${a.name}” and “${b.name}” stay separate and this suggestion is closed.`}
        confirmLabel="Not a duplicate"
        confirmVariant="default"
        onConfirm={() => {
          setDismissOpen(false);
          void act(row.id, () => dismiss.mutateAsync(row.id), "Suggestion dismissed");
        }}
      />
      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Merge these companies?</DialogTitle>
            <DialogDescription>
              Choose the company that stays. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <div
            role="radiogroup"
            aria-label="Company that stays"
            className="grid gap-2 sm:grid-cols-2"
          >
            {[a, b].map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={keepId === c.id}
                onClick={() => setKeepId(c.id)}
                className={cn(
                  "rounded-lg border p-3 text-left",
                  keepId === c.id ? "border-primary bg-accent" : "hover:bg-muted",
                )}
              >
                <div className="truncate type-body font-semibold">{c.name}</div>
                <div className="type-small text-muted-foreground">
                  {keepId === c.id ? "Stays" : "Merged away"} · {c.contactCount} contacts
                </div>
              </button>
            ))}
          </div>
          <p className="type-body text-muted-foreground">
            {source.contactCount} contact{source.contactCount === 1 ? "" : "s"} and{" "}
            {source.openDealCount} open deal
            {source.openDealCount === 1 ? "" : "s"} move from “{source.name}” to “{kept.name}”. No
            contact is deleted.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMergeOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setMergeOpen(false);
                void act(
                  row.id,
                  () => merge.mutateAsync({ id: row.id, targetId: kept.id }),
                  `Merged into “${kept.name}”`,
                );
              }}
            >
              Merge into “{kept.name}”
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ContactRow({ row, act }: { row: CompanyDuplicate; act: Act }) {
  const relink = useRelinkDuplicate();
  const dismiss = useDismissDuplicate();
  const [moveOpen, setMoveOpen] = useState(false);
  const [target, setTarget] = useState<IdName | null>(null);
  const contact = row.contact;
  const open = row.status === "open";

  return (
    <Card className="space-y-3 p-4">
      <RowMeta row={row} />
      <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <div className="min-w-0 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <User className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {contact ? (
              <Link
                to="/contacts/$contactId"
                params={{ contactId: contact.id }}
                className="truncate type-body font-semibold hover:underline"
              >
                {contact.name || contact.email || "Unnamed contact"}
              </Link>
            ) : (
              <span className="type-body text-muted-foreground">Contact deleted</span>
            )}
          </div>
          {contact?.email && (
            <div className="truncate type-small text-muted-foreground">{contact.email}</div>
          )}
          <div className="mt-1 type-small">
            Says “{row.observedName ?? contact?.company ?? "–"}”
            {row.observedDomain && (
              <span className="text-muted-foreground"> · {row.observedDomain}</span>
            )}
          </div>
        </div>
        <ArrowRight
          className="mx-auto size-4 text-muted-foreground max-sm:rotate-90"
          aria-label="is linked to"
        />
        <CompanyCard company={row.companyA} />
      </div>
      {open && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void act(row.id, () => dismiss.mutateAsync(row.id), "Link kept")}
          >
            Keep link
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMoveOpen(true)}>
            Move to another company…
          </Button>
          {row.observedName && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void act(
                  row.id,
                  () => relink.mutateAsync({ id: row.id }),
                  `Created “${row.observedName}” and moved the contact`,
                )
              }
            >
              Create separate company
            </Button>
          )}
        </div>
      )}
      <Dialog
        open={moveOpen}
        onOpenChange={(value) => {
          setMoveOpen(value);
          if (!value) setTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move to another company</DialogTitle>
            <DialogDescription>
              {contact?.name ?? "The contact"} is linked to the company you pick; their company text
              follows.
            </DialogDescription>
          </DialogHeader>
          <CompanyPicker
            value={target}
            onChange={setTarget}
            allowCreate
            excludeIds={[row.companyA.id]}
            label="Company"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMoveOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!target}
              onClick={() => {
                if (!target) return;
                setMoveOpen(false);
                void act(
                  row.id,
                  () => relink.mutateAsync({ id: row.id, companyId: target.id }),
                  `Moved to “${target.name}”`,
                );
              }}
            >
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
