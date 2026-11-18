import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/crm/money";
import { cn } from "@/lib/utils";
import { messageFromError, useCompany, useMergeCompanies } from "@/store";
import type { CompanyDetail, IdName } from "@/types";
import { CompanyPicker } from "./company-picker";

/**
 * Admin: merge this company with another one picked by CompanyPicker. Shows both side by
 * side, the admin picks which one stays, then POST /companies/:keptId/merge {sourceId}.
 * Afterwards the surviving company opens. Contacts are never deleted.
 */
export function MergeCompanyDialog({
  company,
  open,
  onOpenChange,
}: {
  company: CompanyDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const merge = useMergeCompanies();
  const [other, setOther] = useState<IdName | null>(null);
  const [keepId, setKeepId] = useState(company.id);
  const otherDetail = useCompany(other?.id);
  const pair = otherDetail.data ? [company, otherDetail.data] : null;
  const kept = pair?.find((c) => c.id === keepId) ?? company;
  const source = pair?.find((c) => c.id !== keepId);

  const close = (value: boolean) => {
    onOpenChange(value);
    if (!value) {
      setOther(null);
      setKeepId(company.id);
    }
  };
  const run = async () => {
    if (!source) return;
    try {
      const result = await merge.mutateAsync({ targetId: kept.id, sourceId: source.id });
      toast.success(
        `Merged "${source.name}" into "${kept.name}" (${result.movedContacts} contact${result.movedContacts === 1 ? "" : "s"} moved)`,
      );
      close(false);
      if (kept.id !== company.id)
        void navigate({ to: "/companies/$companyId", params: { companyId: kept.id } });
    } catch (error) {
      toast.error(messageFromError(error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge companies</DialogTitle>
          <DialogDescription>
            Pick the duplicate of “{company.name}”, then choose which company stays.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="mb-1.5 block text-xs">Other company</Label>
            <CompanyPicker
              value={other}
              onChange={(c) => {
                setOther(c);
                setKeepId(company.id);
              }}
              excludeIds={[company.id]}
              placeholder="Search for the duplicate…"
              label="Other company"
            />
          </div>
          {other && !pair && (
            <p className="type-small text-muted-foreground">
              {otherDetail.error ? messageFromError(otherDetail.error) : "Loading…"}
            </p>
          )}
          {pair && source && (
            <>
              <div
                role="radiogroup"
                aria-label="Company that stays"
                className="grid gap-3 sm:grid-cols-2"
              >
                {pair.map((c) => (
                  <MergeSide
                    key={c.id}
                    company={c}
                    keep={c.id === keepId}
                    onKeep={() => setKeepId(c.id)}
                  />
                ))}
              </div>
              <div className="rounded-md bg-info-soft p-3 type-body text-info-soft-foreground">
                <p>
                  <strong>{source.contactCount}</strong> contact
                  {source.contactCount === 1 ? "" : "s"} and <strong>{source.openDealCount}</strong>{" "}
                  open deal
                  {source.openDealCount === 1 ? "" : "s"} (and its closed deals) move from “
                  {source.name}” to “{kept.name}”.
                </p>
                <p className="mt-1">
                  “{kept.name}” keeps its name; its empty fields are filled from “{source.name}”.
                  The moved contacts’ company text becomes “{kept.name}”. “{source.name}” is hidden
                  and its old links open “{kept.name}”. No contact is deleted.
                </p>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button disabled={!source || merge.isPending} onClick={() => void run()}>
            {merge.isPending ? "Merging…" : source ? `Merge into “${kept.name}”` : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MergeSide({
  company,
  keep,
  onKeep,
}: {
  company: CompanyDetail;
  keep: boolean;
  onKeep: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={keep}
      onClick={onKeep}
      className={cn(
        "rounded-lg border p-3 text-left transition-colors",
        keep ? "border-primary bg-accent" : "hover:bg-muted",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate type-body font-semibold">{company.name}</span>
        <span className={cn("type-small", keep ? "text-primary" : "text-muted-foreground")}>
          {keep ? "Stays" : "Merged away"}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 type-small">
        <dt className="text-muted-foreground">Domain</dt>
        <dd className="truncate">{company.domain ?? "–"}</dd>
        <dt className="text-muted-foreground">Industry</dt>
        <dd className="truncate">{company.industry ?? "–"}</dd>
        <dt className="text-muted-foreground">Contacts</dt>
        <dd className="num">{company.contactCount}</dd>
        <dt className="text-muted-foreground">Open deals</dt>
        <dd>
          <span className="num">{company.openDealCount}</span>{" "}
          <Money amount={company.openDealAmount} compact className="text-muted-foreground" />
        </dd>
      </dl>
    </button>
  );
}
