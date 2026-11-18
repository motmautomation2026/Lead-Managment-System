import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  CalendarPlus,
  Check,
  ChevronDown,
  ClipboardList,
  FileText,
  Phone,
  Plus,
  RotateCcw,
  StickyNote,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { RecordShell, type RailCard } from "@/components/crm/record-shell";
import { RelativeTime } from "@/components/crm/relative-time";
import { UserAvatar } from "@/components/crm/user-avatar";
import { ActivityFeed } from "@/features/crm/activity-feed";
import { RecordBreadcrumb } from "@/features/crm/record-breadcrumb";
import { RecordComposer } from "@/features/crm/record-composer";
import { SendProposalDialog } from "@/features/proposals/components/send-proposal-dialog";
import { useCreateTaskDialog } from "@/app/add-lead-context";
import { LogCallFlow } from "@/features/work/log-call-flow";
import { ProposalStatusDialog } from "@/features/work/proposal-status-dialog";
import { ViewDocumentButton } from "@/features/work/proposal-document";
import { ScheduleMeetingFlow } from "@/features/work/schedule-meeting-flow";
import { BackendError } from "@/lib/backend-client";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/labels";
import { cn } from "@/lib/utils";
import {
  messageFromError,
  useCreateProposal,
  useDeal,
  useDeals,
  useMeetingList,
  useMoveDealStage,
  useProposalList,
  useTaskList,
} from "@/store";
import { DEAL_STAGES, type DealDetail, type DealStage, type ProposalListItem } from "@/types";
import { CloseDealDialog, type CloseMode } from "./close-deal-dialog";
import { DealAbout, DealOwnerSelect } from "./deal-about";
import { closeDate } from "./deal-columns";
import { DEAL_STAGE_LABELS, OPEN_DEAL_STAGES, isClosedStage } from "./deal-labels";
import { DealStagePill } from "./deal-stage-pill";
import { RecordLink } from "@/features/crm/record-link";
import { useRememberRecent } from "@/features/crm/recent";
import { EmailStatusPill } from "@/features/meetings/meeting-status-icons";

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
  const createProposal = useCreateProposal();
  const createTask = useCreateTaskDialog();
  // C6a: the deal's work through the list endpoints (first 10; "View all" opens the page).
  const tasks = useTaskList({ dealId: deal.id, status: "open", limit: 10 });
  const meetings = useMeetingList({ dealId: deal.id, sort: "at:desc", limit: 10 });
  const proposals = useProposalList({ dealId: deal.id, limit: 10 });
  const rows = <T,>(list: { data?: { pages: { data: T[] }[] } | undefined }) =>
    list.data?.pages.flatMap((p) => p.data) ?? [];
  const [closeMode, setCloseMode] = useState<CloseMode | null>(null);
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [statusFor, setStatusFor] = useState<ProposalListItem | null>(null);
  const closed = isClosedStage(deal.stage);
  const dnc = deal.contact.lifecycle === "do_not_contact";
  const otherDeals = useDeals({ leadId: deal.contact.id, status: "all", limit: 6 });
  const others = (otherDeals.data?.pages[0]?.data ?? []).filter((d) => d.id !== deal.id);

  /** Open stages move at once; won/lost go through the Close dialog. */
  const goTo = (stage: DealStage) => {
    if (stage === deal.stage) return;
    if (isClosedStage(stage)) return setCloseMode(stage as CloseMode);
    // LL-3: negotiation asks for the next decision date first.
    if (stage === "negotiation") return setCloseMode("negotiation");
    void move
      .mutateAsync({ id: deal.id, stage })
      .then(() => toast.success(`Moved to ${DEAL_STAGE_LABELS[stage]}`))
      .catch((error: unknown) => toast.error(messageFromError(error)));
  };

  const focusNote = () =>
    document.querySelector<HTMLTextAreaElement>('[aria-label="New note"]')?.focus();

  const actions = (
    <>
      {closed ? (
        <Button size="sm" variant="outline" onClick={() => setCloseMode("reopen")}>
          <RotateCcw /> Reopen
        </Button>
      ) : (
        <>
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
          <Button size="sm" variant="outline" onClick={() => setCloseMode("won")}>
            <Check /> Mark won
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCloseMode("lost")}>
            <X /> Mark lost
          </Button>
        </>
      )}
      <Button size="sm" variant="outline" onClick={() => setCallOpen(true)} disabled={dnc}>
        <Phone /> Log call
      </Button>
      <Button size="sm" variant="outline" onClick={focusNote}>
        <StickyNote /> Note
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            More <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => createTask.open({ contact: deal.contact })}>
            <ClipboardList /> Create task
          </DropdownMenuItem>
          <DropdownMenuItem disabled={dnc} onSelect={() => setMeetingOpen(true)}>
            <CalendarPlus /> Schedule meeting
          </DropdownMenuItem>
          <DropdownMenuItem disabled={dnc} onSelect={() => setProposalOpen(true)}>
            <FileText /> Send proposal
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  const header = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="type-page-title break-words">{deal.name}</h1>
            <DealStagePill stage={deal.stage} />
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 type-small text-muted-foreground">
            <span className="font-medium text-foreground">
              {deal.amount === null ? (
                "No amount"
              ) : (
                <Money amount={deal.amount} currency={deal.currency} />
              )}
            </span>
            <span>
              {deal.expectedCloseDate
                ? `Close ${closeDate(deal.expectedCloseDate)}`
                : "No close date"}
            </span>
            {deal.stage === "negotiation" && deal.nextDecisionDate && (
              <span>Decision {closeDate(deal.nextDecisionDate)}</span>
            )}
            <RecordLink
              type="contact"
              id={deal.contact.id}
              className="text-primary hover:underline"
            >
              {deal.contact.name || "Unnamed contact"}
            </RecordLink>
            {deal.company && (
              <RecordLink
                type="company"
                id={deal.company.id}
                className="text-primary hover:underline"
              >
                {deal.company.name}
              </RecordLink>
            )}
            <span className="inline-flex items-center gap-1.5">
              <UserAvatar name={deal.owner?.name} size="sm" />
              <DealOwnerSelect deal={deal} className="h-7 w-auto gap-1.5 text-xs" />
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">{actions}</div>
      </div>
      <StageProgress stage={deal.stage} onPick={goTo} disabled={move.isPending} />
    </div>
  );

  const viewAll = (to: "/tasks" | "/meetings" | "/proposals", what: string): ReactNode => (
    <Link
      to={to}
      search={{ dealId: deal.id, view: "everyone" }}
      className="type-small text-primary hover:underline"
      aria-label={`View all ${what}`}
    >
      View all
    </Link>
  );

  const taskRows = rows(tasks);
  const meetingRows = rows(meetings);
  const proposalRows = rows(proposals);
  const meetingsAndProposals = (
    <div className="space-y-4">
      <section className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="type-label">Meetings</h3>
          <Button size="sm" variant="ghost" onClick={() => setMeetingOpen(true)} disabled={dnc}>
            <Plus /> Schedule
          </Button>
        </div>
        <AssociationCard
          bare
          title="Meetings"
          emptyText="No meetings linked to this deal."
          footer={viewAll("/meetings", "meetings")}
          items={meetingRows.map((m) => ({
            id: m.id,
            title: m.title,
            subtitle: fmtDateTime(m.at),
            meta: (
              <span className="inline-flex flex-wrap justify-end gap-1">
                <StatusBadge value={m.status} />
                {m.outcome && <StatusBadge value={m.outcome} />}
                {m.notifyEmailStatus && m.notifyEmailStatus !== "not_applicable" && (
                  <EmailStatusPill status={m.notifyEmailStatus} error={m.notifyEmailError} />
                )}
              </span>
            ),
          }))}
        />
      </section>
      <section className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="type-label">Proposals</h3>
          <Button size="sm" variant="ghost" onClick={() => setProposalOpen(true)} disabled={dnc}>
            <Plus /> Send
          </Button>
        </div>
        <AssociationCard
          bare
          title="Proposals"
          emptyText="No proposals linked to this deal."
          footer={viewAll("/proposals", "proposals")}
          items={proposalRows.map((p) => ({
            id: p.id,
            title: p.title,
            subtitle:
              p.amount === undefined ? null : <Money amount={p.amount} currency={p.currency} />,
            meta: (
              <span className="inline-flex flex-wrap items-center justify-end gap-1">
                <StatusBadge value={p.status} />
                {p.emailSendStatus !== "not_applicable" && (
                  <EmailStatusPill status={p.emailSendStatus} error={p.emailSendError} />
                )}
                <ViewDocumentButton proposal={p} className="h-7" />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => setStatusFor(p)}
                  aria-label={`Change status of ${p.title}`}
                >
                  Change
                </Button>
              </span>
            ),
          }))}
        />
      </section>
    </div>
  );

  const rail: RailCard[] = [
    { id: "about", title: "About", content: <DealAbout deal={deal} /> },
    {
      id: "contact",
      title: "Contact",
      content: (
        <AssociationCard
          bare
          title="Contact"
          items={[
            {
              id: deal.contact.id,
              title: (
                <RecordLink type="contact" id={deal.contact.id} className="hover:underline">
                  {deal.contact.name || "Unnamed contact"}
                </RecordLink>
              ),
              subtitle:
                [deal.contact.email, deal.contact.phone].filter(Boolean).join(" · ") || null,
              meta: <StatusBadge value={deal.contact.lifecycle} />,
            },
          ]}
        />
      ),
    },
    {
      id: "company",
      title: "Company",
      content: (
        <AssociationCard
          bare
          title="Company"
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
      ),
    },
    {
      id: "tasks",
      title: "Next tasks",
      badge: taskRows.length,
      action: (
        <Button
          size="sm"
          variant="ghost"
          aria-label="Create task"
          onClick={() => createTask.open({ contact: deal.contact })}
        >
          <Plus /> Task
        </Button>
      ),
      content: (
        <AssociationCard
          bare
          title="Open tasks"
          emptyText="No open tasks for this deal's contact."
          footer={viewAll("/tasks", "tasks")}
          items={taskRows.map((t) => ({
            id: t.id,
            title: t.title,
            subtitle: (
              <RelativeTime value={t.dueAt} className={t.isOverdue ? "text-destructive" : ""} />
            ),
            meta: t.ownerName ?? "No owner",
          }))}
        />
      ),
    },
    {
      id: "meetings",
      title: "Meetings & proposals",
      badge: meetingRows.length + proposalRows.length,
      content: meetingsAndProposals,
    },
    {
      id: "others",
      title: "Other deals of this contact",
      badge: others.length,
      defaultOpen: false,
      content: (
        <AssociationCard
          bare
          title="Other deals of this contact"
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
      ),
    },
  ];

  return (
    <>
      <RecordShell
        railKey="deal"
        breadcrumb={<RecordBreadcrumb list="/deals" label="Deals" name={deal.name} />}
        header={header}
        banner={
          deal.stage === "lost" && (
            <div className="mx-4 mt-3 rounded-md border border-danger/25 bg-danger-soft px-4 py-3 type-body text-danger-soft-foreground sm:mx-6">
              <span className="font-medium">Lost: {label(deal.lossReason)}</span>
              {deal.lossNotes && (
                <span className="block whitespace-pre-wrap">{deal.lossNotes}</span>
              )}
            </div>
          )
        }
        main={
          <>
            <RecordComposer
              contactId={deal.contact.id}
              dealId={deal.id}
              canCall={!dnc}
              onConnected={() => setCallOpen(true)}
            />
            <ActivityFeed dealId={deal.id} />
          </>
        }
        rail={rail}
      />

      <CloseDealDialog
        deal={deal}
        mode={closeMode ?? "won"}
        open={closeMode !== null}
        onOpenChange={(open) => !open && setCloseMode(null)}
      />
      <ScheduleMeetingFlow
        leadId={deal.contact.id}
        dealId={deal.id}
        open={meetingOpen}
        onOpenChange={setMeetingOpen}
      />
      <LogCallFlow
        leadId={deal.contact.id}
        dealId={deal.id}
        open={callOpen}
        onOpenChange={setCallOpen}
      />
      <ProposalStatusDialog
        key={statusFor?.id ?? "none"}
        proposal={statusFor}
        open={Boolean(statusFor)}
        onOpenChange={(open) => !open && setStatusFor(null)}
      />
      <SendProposalDialog
        leadId={deal.contact.id}
        dealId={deal.id}
        open={proposalOpen}
        onOpenChange={setProposalOpen}
        onSend={(value) =>
          createProposal.mutateAsync({
            leadId: deal.contact.id,
            title: value.title,
            validUntil: value.validUntil || undefined,
            amount: value.amount ? Number(value.amount) : undefined,
            notes: value.notes || undefined,
            emailTemplateId: value.emailTemplateId,
            whatsappTemplateId: value.whatsappTemplateId,
            document: value.document,
            dealId: value.dealId,
          })
        }
      />
    </>
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
