import { useState } from "react";
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
import { AssociationCard } from "@/components/crm/association-card";
import { Money } from "@/components/crm/money";
import { RelativeTime } from "@/components/crm/relative-time";
import { useCreateDealDialog } from "@/app/add-lead-context";
import { messageFromError, useCompany, useLeadMutations } from "@/store";
import type { ContactDetail, IdName } from "@/types";
import { CompanyPicker } from "@/features/companies/company-picker";
import { DealStagePill } from "@/features/deals/deal-stage-pill";
import { RecordLink } from "@/features/crm/record-link";

/** Right panel: the contact's company and deals. */
export function ContactAssociations({ contact }: { contact: ContactDetail }) {
  const company = useCompany(contact.company?.id);
  const [changeOpen, setChangeOpen] = useState(false);
  const createDeal = useCreateDealDialog();
  const c = company.data;

  return (
    <>
      <AssociationCard
        title="Company"
        count={contact.company ? 1 : 0}
        addLabel="Change"
        onAdd={() => setChangeOpen(true)}
        emptyText={
          contact.companyText
            ? `“${contact.companyText}” isn't linked to a company record yet.`
            : "No company."
        }
        items={
          contact.company
            ? [
                {
                  id: contact.company.id,
                  title: (
                    <RecordLink type="company" id={contact.company.id} className="hover:underline">
                      {contact.company.name}
                    </RecordLink>
                  ),
                  subtitle:
                    [contact.company.domain, c?.industry].filter(Boolean).join(" · ") || null,
                  meta: c ? (
                    <span className="type-small text-muted-foreground">
                      {c.contactCount} contact{c.contactCount === 1 ? "" : "s"}
                    </span>
                  ) : null,
                },
              ]
            : []
        }
      />
      <AssociationCard
        title="Deals"
        addLabel="Create deal"
        onAdd={() =>
          createDeal.open({
            contact: { id: contact.id, name: `${contact.firstName} ${contact.lastName}`.trim() },
            stay: true,
          })
        }
        emptyText="No deals yet."
        items={contact.deals.map((d) => ({
          id: d.id,
          title: (
            <RecordLink type="deal" id={d.id} className="hover:underline">
              {d.name}
            </RecordLink>
          ),
          subtitle: (
            <span className="inline-flex items-center gap-2">
              <DealStagePill stage={d.stage} />
              <Money amount={d.amount} currency={d.currency} compact />
            </span>
          ),
          meta: d.closedAt ? (
            <span className="type-small text-muted-foreground">
              Closed <RelativeTime value={d.closedAt} />
            </span>
          ) : (
            <span className="type-small text-muted-foreground">Open</span>
          ),
        }))}
      />

      <Dialog open={changeOpen} onOpenChange={setChangeOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Change company</DialogTitle>
            <DialogDescription>
              Pick the company record. The contact&rsquo;s company text becomes its name and the
              contact is relinked to it.
            </DialogDescription>
          </DialogHeader>
          {changeOpen && <ChangeCompanyForm contact={contact} done={() => setChangeOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Change company: a CompanyPicker (or create); PATCH /leads/:id `company` = its name, the backend relinks. */
function ChangeCompanyForm({ contact, done }: { contact: ContactDetail; done: () => void }) {
  const { updateLead } = useLeadMutations();
  const [picked, setPicked] = useState<IdName | null>(contact.company);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!picked) return;
    setSaving(true);
    setError(null);
    try {
      await updateLead(contact.id, { company: picked.name });
      toast.success("Company changed");
      done();
    } catch (e) {
      setError(messageFromError(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-3">
      <CompanyPicker value={picked} onChange={setPicked} allowCreate label="Company" />
      {error && <p className="type-small text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={done}>
          Cancel
        </Button>
        <Button
          disabled={!picked || picked.id === contact.company?.id || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </div>
  );
}
