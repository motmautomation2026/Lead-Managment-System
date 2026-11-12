import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ExternalLink, ListPlus, Phone, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DetailDrawer } from "@/components/crm/detail-drawer";
import { PropertyList, type Property } from "@/components/crm/property-list";
import { RelativeTime } from "@/components/crm/relative-time";
import { Money } from "@/components/crm/money";
import { SectionSkeleton } from "@/components/crm/section-skeleton";
import { ErrorBlock } from "@/components/common/server-state";
import { useCreateTaskDialog } from "@/app/add-lead-context";
import { AGENT_STATUS_LABEL } from "@/features/agent/agent-labels";
import { HotScorePill } from "@/features/contacts/hot-score";
import { NoteDialog } from "@/features/contacts/note-dialog";
import { DEAL_STAGE_LABELS } from "@/features/deals/deal-labels";
import { LogCallFlow } from "@/features/work/log-call-flow";
import { label } from "@/lib/labels";
import { messageFromError, useCompany, useContact, useDeal, useLeadMutations } from "@/store";
import { ActivityFeed } from "./activity-feed";

export type PeekType = "contact" | "company" | "deal";

const dash = <span className="text-muted-foreground">–</span>;
const full: Record<PeekType, (id: string) => string> = {
  contact: (id) => `/contacts/${id}`,
  company: (id) => `/companies/${id}`,
  deal: (id) => `/deals/${id}`,
};

/**
 * UX-2 peek: one record in the right-hand drawer without leaving the list (key facts, last
 * activity, next task, primary actions, "Open full page"). The list page keeps `?peek=<id>` in
 * the URL, so filters, scroll and selection stay and Back closes it. Lazy-loaded by the lists.
 */
export default function RecordPeek({
  type,
  id,
  onClose,
}: {
  type: PeekType;
  id: string;
  onClose: () => void;
}) {
  const body =
    type === "contact" ? (
      <ContactPeek id={id} />
    ) : type === "company" ? (
      <CompanyPeek id={id} />
    ) : (
      <DealPeek id={id} />
    );
  return (
    <DetailDrawer
      open
      onOpenChange={(open) => !open && onClose()}
      title={<PeekTitle type={type} id={id} />}
      footer={
        <Button asChild variant="outline" size="sm">
          <Link to={full[type](id)}>
            <ExternalLink /> Open full page
          </Link>
        </Button>
      }
    >
      {body}
    </DetailDrawer>
  );
}

function PeekTitle({ type, id }: { type: PeekType; id: string }) {
  if (type === "contact") return <ContactTitle id={id} />;
  if (type === "company") return <CompanyTitle id={id} />;
  return <DealTitle id={id} />;
}
function ContactTitle({ id }: { id: string }) {
  const c = useContact(id).data;
  return c ? `${c.firstName} ${c.lastName}`.trim() || "Unnamed contact" : "Loading…";
}
function CompanyTitle({ id }: { id: string }) {
  return useCompany(id).data?.name ?? "Loading…";
}
function DealTitle({ id }: { id: string }) {
  return useDeal(id).data?.name ?? "Loading…";
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 pt-4" aria-label={title}>
      <h3 className="type-label text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function State({ query }: { query: { isLoading: boolean; error: unknown } }) {
  if (query.isLoading) return <SectionSkeleton />;
  return query.error ? <ErrorBlock error={query.error} /> : null;
}

function ContactPeek({ id }: { id: string }) {
  const query = useContact(id);
  const createTask = useCreateTaskDialog();
  const { addNote } = useLeadMutations();
  const [callOpen, setCallOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const c = query.data;
  if (!c) return <State query={query} />;
  const name = `${c.firstName} ${c.lastName}`.trim();
  const dnc = c.lifecycleState === "do_not_contact";
  const openDeal = c.deals.find((d) => d.stage !== "won" && d.stage !== "lost");
  const items: Property[] = [
    { id: "company", label: "Company", value: c.company?.name ?? (c.companyText || dash) },
    {
      id: "phone",
      label: "Phone",
      value: c.phone ? (
        <a href={`tel:${c.phone}`} className="text-primary hover:underline">
          {c.phone}
        </a>
      ) : (
        dash
      ),
    },
    { id: "email", label: "Email", value: c.email || dash },
    { id: "owner", label: "Owner", value: c.ownerName ?? "No owner" },
    { id: "status", label: "Lead status", value: label(c.pipelineStage) },
    {
      id: "hot",
      label: "Hot score",
      value: <HotScorePill score={c.hotScore} band={c.hotBand} reasons={c.hotReasons} />,
    },
    { id: "ai", label: "AI status", value: AGENT_STATUS_LABEL[c.agentStatus] },
    { id: "enquiry", label: "Enquiry", value: c.serviceInterest || dash },
    {
      id: "next",
      label: "Next task",
      value: c.nextAction ? (
        <>
          {c.nextAction.title} · <RelativeTime value={c.nextAction.dueAt} />
        </>
      ) : (
        "None"
      ),
    },
    {
      id: "deal",
      label: "Open deal",
      value: openDeal ? (
        <Link to="/deals/$dealId" params={{ dealId: openDeal.id }} className="hover:underline">
          {openDeal.name}
        </Link>
      ) : (
        "None"
      ),
    },
  ];
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {!dnc && (
          <Button size="sm" onClick={() => setCallOpen(true)}>
            <Phone /> Log call
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => setNoteOpen(true)}>
          <StickyNote /> Add note
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => createTask.open({ contact: { id, name: name || "Contact" } })}
        >
          <ListPlus /> Add task
        </Button>
      </div>
      <PropertyList items={items} />
      <Section title="Last activity">
        <ActivityFeed contactId={id} limit={3} />
      </Section>
      <LogCallFlow leadId={id} open={callOpen} onOpenChange={setCallOpen} />
      <NoteDialog
        open={noteOpen}
        onOpenChange={setNoteOpen}
        onSave={(body) =>
          addNote(id, body).then(
            () => (toast.success("Note added"), true),
            (error: unknown) => (toast.error(messageFromError(error)), false),
          )
        }
      />
    </div>
  );
}

function CompanyPeek({ id }: { id: string }) {
  const query = useCompany(id);
  const c = query.data;
  if (!c) return <State query={query} />;
  return (
    <div>
      <PropertyList
        items={[
          { id: "domain", label: "Domain", value: c.domain || dash },
          { id: "industry", label: "Industry", value: c.industry || dash },
          { id: "city", label: "City", value: c.city || dash },
          { id: "owner", label: "Owner", value: c.owner?.name ?? "No owner" },
          { id: "contacts", label: "Contacts", value: c.contactCount },
          {
            id: "deals",
            label: "Open deals",
            value: (
              <>
                {c.openDealCount} · <Money amount={c.openDealAmount} />
              </>
            ),
          },
        ]}
      />
      <Section title="Last activity">
        <ActivityFeed companyId={id} limit={3} />
      </Section>
    </div>
  );
}

function DealPeek({ id }: { id: string }) {
  const query = useDeal(id);
  const d = query.data;
  if (!d) return <State query={query} />;
  return (
    <div>
      <PropertyList
        items={[
          { id: "stage", label: "Stage", value: DEAL_STAGE_LABELS[d.stage] },
          {
            id: "amount",
            label: "Amount",
            value: <Money amount={d.amount} currency={d.currency} />,
          },
          {
            id: "contact",
            label: "Contact",
            value: (
              <Link
                to="/contacts/$contactId"
                params={{ contactId: d.contact.id }}
                className="hover:underline"
              >
                {d.contact.name}
              </Link>
            ),
          },
          { id: "company", label: "Company", value: d.company?.name ?? dash },
          { id: "owner", label: "Owner", value: d.owner?.name ?? "No owner" },
          {
            id: "close",
            label: "Expected close",
            value: d.expectedCloseDate ?? dash,
          },
        ]}
      />
      <Section title="Last activity">
        <ActivityFeed dealId={id} limit={3} />
      </Section>
    </div>
  );
}
