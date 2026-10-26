import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { CalendarPlus, Check, ChevronDown, FileText, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import { StatusBadge } from "@/components/common/status-badge";
import { AssociationCard } from "@/components/crm/association-card";
import { EmptyState } from "@/components/crm/empty-state";
import { Money } from "@/components/crm/money";
import { PageHeader } from "@/components/crm/page-header";
import { PropertyList } from "@/components/crm/property-list";
import { RecordLayout } from "@/components/crm/record-layout";
import { RelativeTime } from "@/components/crm/relative-time";
import { UserAvatar } from "@/components/crm/user-avatar";
import { ActivityFeed } from "@/features/crm/activity-feed";
import { ScheduleMeetingDialog } from "@/features/meetings/schedule-meeting-dialog";
import { SendProposalDialog } from "@/features/proposals/components/send-proposal-dialog";
import { BackendError } from "@/lib/backend-client";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/labels";
import { cn } from "@/lib/utils";
import {
  messageFromError,
  useDeal,
  useDeals,
  useMeetings,
  useMoveDealStage,
  useProposals,
} from "@/store";
import { DEAL_STAGES, type DealDetail, type DealStage } from "@/types";
import { CloseDealDialog, type CloseMode } from "./close-deal-dialog";
import { DealAbout, DealOwnerSelect } from "./deal-about";
import { closeDate } from "./deal-columns";
import { DEAL_STAGE_LABELS, OPEN_DEAL_STAGES, isClosedStage } from "./deal-labels";
import { DealStagePill } from "./deal-stage-pill";
import { RecordLink } from "@/features/crm/record-link";
import { useRememberRecent } from "@/features/crm/recent";

/** HubSpot-style deal record, fetched by id; 404 → a way back to the list. */
export function DealRecordPage({ dealId }: { dealId: string }) {
  const query = useDeal(dealId);
  useRememberRecent("deal", query.data?.id, query.data?.name ?? "");
  if (query.isLoading) {
    return (
      <div className="p-6">
        <LoadingBlock label="Loading deal…" />
      </div>
    );
  }
  if (!query.data) {
    return query.error instanceof BackendError && query.error.status === 404 ? (
      <EmptyState
        title="Deal not found"
        text="It may have been deleted, or it belongs to another workspace."
        action={
          <Button asChild variant="outline">
            <Link to="/deals">Back to deals</Link>
          </Button>
        }
      />
    ) : (
      <div className="p-6">
        <ErrorBlock error={query.error} />
      </div>
    );
  }
  return <DealRecord key={query.data.id} deal={query.data} />;
}

function DealRecord({ deal }: { deal: DealDetail }) {
  const move = useMoveDealStage();
  const meetingStore = useMeetings();
  const proposalStore = useProposals();
  const [closeMode, setCloseMode] = useState<CloseMode | null>(null);
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [savingMeeting, setSavingMeeting] = useState(false);
  const [proposalOpen, setProposalOpen] = useState(false);
  const closed = isClosedStage(deal.stage);
  const otherDeals = useDeals({ leadId: deal.contact.id, status: "all", limit: 6 });
  const others = (otherDeals.data?.pages[0]?.data ?? []).filter((d) => d.id !== deal.id);

  /** Open stages move at once; won/lost go through the Close dialog. */
  const goTo = (stage: DealStage) => {
    if (stage === deal.stage) return;
    if (isClosedStage(stage)) return setCloseMode(stage as CloseMode);
    void move
      .mutateAsync({ id: deal.id, stage })
      .then(() => toast.success(`Moved to ${DEAL_STAGE_LABELS[stage]}`))
      .catch((error: unknown) => toast.error(messageFromError(error)));
  };

  const heading = (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="type-page-title break-words">{deal.name}</h1>
        <DealStagePill stage={deal.stage} />
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 type-body text-muted-foreground">
        <span className="font-medium text-foreground">
          {deal.amount === null ? (
            "No amount"
          ) : (
            <Money amount={deal.amount} currency={deal.currency} />
          )}
        </span>
        <span>
          {deal.expectedCloseDate ? `Close ${closeDate(deal.expectedCloseDate)}` : "No close date"}
        </span>
        <RecordLink type="contact" id={deal.contact.id} className="text-primary hover:underline">
          {deal.contact.name || "Unnamed contact"}
        </RecordLink>
        {deal.company && (
          <RecordLink type="company" id={deal.company.id} className="text-primary hover:underline">
            {deal.company.name}
          </RecordLink>
        )}
      </p>
      <div className="flex items-center gap-1.5">
        <UserAvatar name={deal.owner?.name} size="sm" />
        <DealOwnerSelect deal={deal} className="h-7 w-auto gap-1.5 text-xs" />
      </div>
    </div>
  );

  const actions = (
    <>
      {closed ? (
        <Button size="sm" variant="outline" onClick={() => setCloseMode("reopen")}>
          <RotateCcw /> Reopen
        </Button>
      ) : (
        <>
          <Button size="sm" variant="outline" onClick={() => setCloseMode("won")}>
            <Check /> Mark won
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCloseMode("lost")}>
            <X /> Mark lost
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                Move stage <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {OPEN_DEAL_STAGES.filter((s) => s !== deal.stage).map((s) => (
                <DropdownMenuItem key={s} onSelect={() => goTo(s)}>
                  {DEAL_STAGE_LABELS[s]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      <Button size="sm" variant="outline" onClick={() => setMeetingOpen(true)}>
        <CalendarPlus /> Schedule meeting
      </Button>
      <Button size="sm" variant="outline" onClick={() => setProposalOpen(true)}>
        <FileText /> Send proposal
      </Button>
    </>
  );

  const nextMeeting = deal.meetings
    .filter((m) => new Date(m.at).getTime() > Date.now() && m.status !== "cancelled")
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  const latestProposal = deal.proposals[0];

  const overview = (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="mb-1 type-section-title">Key facts</h2>
        <PropertyList
          items={[
            { id: "stage", label: "Stage", value: <DealStagePill stage={deal.stage} /> },
            {
              id: "amount",
              label: "Amount",
              value:
                deal.amount === null ? null : (
                  <Money amount={deal.amount} currency={deal.currency} />
                ),
            },
            { id: "close", label: "Expected close", value: closeDate(deal.expectedCloseDate) },
            { id: "interest", label: "Service interest", value: deal.serviceInterest },
            {
              id: "nextMeeting",
              label: "Next meeting",
              value: nextMeeting ? `${nextMeeting.title} · ${fmtDateTime(nextMeeting.at)}` : null,
            },
            {
              id: "latestProposal",
              label: "Latest proposal",
              value: latestProposal ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  {latestProposal.title}
                  <StatusBadge value={latestProposal.status} />
                </span>
              ) : null,
            },
          ]}
        />
      </Card>
      <section className="space-y-2">
        <h2 className="type-section-title">Recent activity</h2>
        <ActivityFeed dealId={deal.id} limit={5} />
      </section>
    </div>
  );

  const meetingsAndProposals = (
    <div className="space-y-4">
      <AssociationCard
        title="Meetings"
        onAdd={() => setMeetingOpen(true)}
        addLabel="Schedule"
        emptyText="No meetings linked to this deal."
        items={deal.meetings.map((m) => ({
          id: m.id,
          title: m.title,
          subtitle: fmtDateTime(m.at),
          meta: (
            <span className="inline-flex flex-wrap justify-end gap-1">
              <StatusBadge value={m.status} />
              {m.outcome && <StatusBadge value={m.outcome} />}
            </span>
          ),
        }))}
      />
      <AssociationCard
        title="Proposals"
        onAdd={() => setProposalOpen(true)}
        addLabel="Send"
        emptyText="No proposals linked to this deal."
        items={deal.proposals.map((p) => ({
          id: p.id,
          title: p.title,
          subtitle: p.amount === null ? null : <Money amount={p.amount} currency={p.currency} />,
          meta: <StatusBadge value={p.status} />,
        }))}
      />
    </div>
  );

  const right = (
    <>
      <AssociationCard
        title="Contact"
        count={1}
        items={[
          {
            id: deal.contact.id,
            title: (
              <RecordLink type="contact" id={deal.contact.id} className="hover:underline">
                {deal.contact.name || "Unnamed contact"}
              </RecordLink>
            ),
            subtitle: [deal.contact.email, deal.contact.phone].filter(Boolean).join(" · ") || null,
            meta: <StatusBadge value={deal.contact.lifecycle} />,
          },
        ]}
      />
      <AssociationCard
        title="Company"
        count={deal.company ? 1 : 0}
        emptyText="No company."
        items={
          deal.company
            ? [
                {
                  id: deal.company.id,
                  title: (
                    <RecordLink type="company" id={deal.company.id} className="hover:underline">
                      {deal.company.name}
                    </RecordLink>
                  ),
                },
              ]
            : []
        }
      />
      <AssociationCard
        title="Other deals of this contact"
        count={others.length}
        emptyText="No other deals."
        items={others.map((d) => ({
          id: d.id,
          title: (
            <RecordLink type="deal" id={d.id} className="hover:underline">
              {d.name}
            </RecordLink>
          ),
          subtitle: DEAL_STAGE_LABELS[d.stage],
          meta: <Money amount={d.amount} currency={d.currency} compact />,
        }))}
      />
    </>
  );

  return (
    <div className="pb-10">
      <PageHeader title={deal.name} heading={heading} actions={actions} />
      <div className="space-y-3 px-4 pt-4 sm:px-6">
        <StageProgress stage={deal.stage} onPick={goTo} disabled={move.isPending} />
        {deal.stage === "lost" && (
          <div className="rounded-md border border-danger/25 bg-danger-soft px-4 py-3 type-body text-danger-soft-foreground">
            <span className="font-medium">Lost: {label(deal.lossReason)}</span>
            {deal.lossNotes && <span className="block whitespace-pre-wrap">{deal.lossNotes}</span>}
          </div>
        )}
      </div>
      <RecordLayout
        left={<DealAbout deal={deal} />}
        tabs={[
          { id: "overview", label: "Overview", content: overview },
          { id: "activity", label: "Activity", content: <ActivityFeed dealId={deal.id} /> },
          { id: "meetings", label: "Meetings & proposals", content: meetingsAndProposals },
        ]}
        defaultTab="overview"
        right={right}
        rightLabel="Related"
      />

      <CloseDealDialog
        deal={deal}
        mode={closeMode ?? "won"}
        open={closeMode !== null}
        onOpenChange={(open) => !open && setCloseMode(null)}
      />
      <ScheduleMeetingDialog
        leadId={deal.contact.id}
        dealId={deal.id}
        meeting={null}
        open={meetingOpen}
        isSaving={savingMeeting}
        onOpenChange={setMeetingOpen}
        onSave={(value) =>
          void (async () => {
            setSavingMeeting(true);
            try {
              await meetingStore.addMeeting(value);
              toast.success("Meeting scheduled");
              setMeetingOpen(false);
            } catch (error) {
              toast.error(messageFromError(error));
            } finally {
              setSavingMeeting(false);
            }
          })()
        }
      />
      <SendProposalDialog
        leadId={deal.contact.id}
        dealId={deal.id}
        open={proposalOpen}
        onOpenChange={setProposalOpen}
        onSend={(value) =>
          proposalStore.addProposal({
            leadId: deal.contact.id,
            title: value.title,
            amount: value.amount ? Number(value.amount) : undefined,
            notes: value.notes || undefined,
            emailTemplateId: value.emailTemplateId,
            whatsappTemplateId: value.whatsappTemplateId,
            document: value.document,
            dealId: value.dealId,
          })
        }
      />
    </div>
  );
}

/** The pipeline left to right; the current stage is highlighted. Open stages move at once. */
function StageProgress({
  stage,
  onPick,
  disabled,
}: {
  stage: DealStage;
  onPick: (stage: DealStage) => void;
  disabled: boolean;
}) {
  const reached = DEAL_STAGES.indexOf(stage);
  return (
    <ol className="flex gap-1 overflow-x-auto" aria-label="Deal stage">
      {DEAL_STAGES.map((s, i) => {
        const current = s === stage;
        const done = !isClosedStage(stage) && i < reached;
        return (
          <li key={s} className="min-w-28 flex-1">
            <button
              type="button"
              disabled={disabled || current}
              aria-current={current ? "step" : undefined}
              onClick={() => onPick(s)}
              className={cn(
                "w-full truncate rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
                current
                  ? s === "lost"
                    ? "border-danger/25 bg-danger-soft text-danger-soft-foreground"
                    : s === "won"
                      ? "border-success/25 bg-success-soft text-success-soft-foreground"
                      : "border-primary bg-primary text-primary-foreground"
                  : done
                    ? "border-primary/25 bg-accent text-accent-foreground hover:bg-accent/80"
                    : "bg-card text-muted-foreground hover:bg-muted",
              )}
            >
              {DEAL_STAGE_LABELS[s]}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
