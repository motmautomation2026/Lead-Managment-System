import { NoteDialog } from "./note-dialog";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarPlus,
  Check,
  ChevronDown,
  ClipboardList,
  FileText,
  Plus,
  MessageSquare,
  Phone,
  StickyNote,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorBlock, LoadingBlock } from "@/components/common/server-state";
import { StatusBadge, TaskOriginBadge } from "@/components/common/status-badge";
import { RecordShell, type RailCard } from "@/components/crm/record-shell";
import { StatusPill } from "@/components/crm/status-pill";
import { UserAvatar } from "@/components/crm/user-avatar";
import { EmptyState } from "@/components/crm/empty-state";
import { RelativeTime } from "@/components/crm/relative-time";
import { Money } from "@/components/crm/money";
import { LeadAiPanel } from "@/features/agent/lead-ai-panel";
import { ActivityFeed } from "@/features/crm/activity-feed";
import type { ContactRecordSearch } from "./contact-helpers";
import { LeadJourneyCard } from "@/features/leads/lead-journey-card";
import { EnrollWorkflowDialog } from "@/features/leads/scheduled-followups";
import {
  DiscardDialog,
  LostReasonDialog,
  NextActionDialog,
  ReasonDialog,
} from "@/features/leads/lead-dialogs";
import { OutcomeDialog } from "@/features/work/meeting-outcome-dialog";
import { LogCallFlow } from "@/features/work/log-call-flow";
import { ProposalStatusDialog } from "@/features/work/proposal-status-dialog";
import { ViewDocumentButton } from "@/features/work/proposal-document";
import { ScheduleMeetingFlow } from "@/features/work/schedule-meeting-flow";
import { useCreateDealDialog, useCreateTaskDialog } from "@/app/add-lead-context";
import { SendProposalDialog } from "@/features/proposals/components/send-proposal-dialog";
import { BackendError } from "@/lib/backend-client";
import { toastUndo } from "@/lib/toast-undo";
import { fmtDate, fmtDateTime, isOverdue, relDay } from "@/lib/format";
import { label } from "@/lib/labels";
import { nurtureTriggerForStage } from "@/lib/pipeline";
import { currentStepText } from "@/features/automations/run-labels";
import {
  messageFromError,
  useContact,
  useRunList,
  useScheduledActionList,
  useLead,
  useLeadMutations,
  useCancelTask,
  useCompleteTask,
  useReopenTask,
  useCreateProposal,
  useCreateTask,
  useMeetingList,
  useProposalList,
  useRecordMeetingOutcome,
  useSession,
  useTaskList,
  useUpdateTask,
} from "@/store";
import {
  AUTOMATION_MODES,
  type AutomationMode,
  type ContactDetail,
  type LeadLossReason,
  type ProposalListItem,
  type WorkflowTrigger,
} from "@/types";
import { ContactAbout } from "./contact-about";
import { ContactAssociations } from "./contact-associations";
import { RecordLink } from "@/features/crm/record-link";
import { useRememberRecent } from "@/features/crm/recent";
import { EmailStatusPill } from "@/features/meetings/meeting-status-icons";
import { RecordBreadcrumb } from "@/features/crm/record-breadcrumb";
import { RecordComposer } from "@/features/crm/record-composer";
import { InlineOwner } from "@/features/crm/row-controls";
import { LatestSuggestedReply } from "@/features/crm/suggested-reply-card";
import { AGENT_STATUS_LABEL, AGENT_STATUS_TONE } from "@/features/agent/agent-labels";
import { HotScorePill } from "./hot-score";
import { cn } from "@/lib/utils";

const DNC_HINT = "This contact is Do Not Contact. Remove the suppression first.";
/** D3: email statuses that block sending (header warning pills). */
const EMAIL_BLOCKED: Record<string, string> = {
  permanent_bounce: "Bounced",
  invalid: "Invalid",
  unsubscribed: "Unsubscribed",
};

/** Runs a write with a success/error toast; resolves true when it succeeded. */
const mutate = async (work: () => Promise<unknown>, success: string) => {
  try {
    await work();
    toast.success(success);
    return true;
  } catch (error) {
    toast.error(messageFromError(error));
    return false;
  }
};

/** HubSpot-style contact record. The contact is always fetched by id (B11). */
export function ContactRecordPage({
  contactId,
  link = {},
}: {
  contactId: string;
  /** D2 deep link (route search): Activity filter, scroll to the newest reply (`tab` is ignored since UX-3). */
  link?: ContactRecordSearch;
}) {
  const query = useContact(contactId);
  const contact = query.data;
  useRememberRecent(
    "contact",
    contact?.id,
    contact
      ? `${contact.firstName} ${contact.lastName}`.trim() || contact.email || "Unnamed contact"
      : "",
  );
  if (query.isLoading) {
    return (
      <div className="p-6">
        <LoadingBlock label="Loading contact…" />
      </div>
    );
  }
  if (!query.data) {
    return query.error instanceof BackendError && query.error.status === 404 ? (
      <EmptyState
        title="Contact not found"
        text="It may have been deleted, or it belongs to another workspace."
        action={
          <Button asChild variant="outline">
            <Link to="/contacts">Back to contacts</Link>
          </Button>
        }
      />
    ) : (
      <div className="p-6">
        <ErrorBlock error={query.error} />
      </div>
    );
  }
  return <ContactRecord contact={query.data} link={link} />;
}

function ContactRecord({ contact, link }: { contact: ContactDetail; link: ContactRecordSearch }) {
  const id = contact.id;
  // Following a deep link (again) remounts the feed with its Activity filter and reply focus.
  const linkKey = `${link.tab ?? ""}|${link.activity ?? ""}|${link.reply ?? ""}`;
  const navigate = useNavigate();
  const { users, userName } = useSession();
  const actions = useLeadMutations();
  const extras = useLead(id);
  // C6b: the contact's runs and scheduled steps from the lists ("View all" opens Runs filtered).
  const runList = useRunList({ contactId: contact.id, limit: 20 });
  const stepList = useScheduledActionList({
    contactId: contact.id,
    sort: "scheduledFor:asc",
    limit: 50,
  });
  // C6a: the contact's work through the list endpoints (first 10; "View all" opens the page).
  const taskList = useTaskList({
    contactId: contact.id,
    status: "open",
    sort: "dueAt:asc",
    limit: 10,
  });
  const meetingList = useMeetingList({ contactId: contact.id, sort: "at:desc", limit: 10 });
  const proposalList = useProposalList({ contactId: contact.id, limit: 10 });
  const completeTaskMutation = useCompleteTask();
  const reopenTask = useReopenTask();
  const cancelTask = useCancelTask();
  const createTaskMutation = useCreateTask();
  const updateTask = useUpdateTask();
  const recordOutcome = useRecordMeetingOutcome();
  const createProposal = useCreateProposal();
  const createTask = useCreateTaskDialog();
  const createDeal = useCreateDealDialog();
  const [changeCompanyOpen, setChangeCompanyOpen] = useState(false);
  const [statusFor, setStatusFor] = useState<ProposalListItem | null>(null);

  const [callOpen, setCallOpen] = useState(false);
  const [dialogTaskId, setDialogTaskId] = useState<string | undefined>(undefined);
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollTrigger, setEnrollTrigger] = useState<WorkflowTrigger | undefined>(undefined);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [nextActionOpen, setNextActionOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  const [outcomeFor, setOutcomeFor] = useState<string | null>(null);
  const [dncOpen, setDncOpen] = useState(false);
  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [lostOpen, setLostOpen] = useState(false);
  const [lossReason, setLossReason] = useState<LeadLossReason | "">("");
  const [lossNotes, setLossNotes] = useState("");
  const [lossDetails, setLossDetails] = useState<{ competitorName: string; projectDate: string }>({
    competitorName: "",
    projectDate: "",
  });
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const name = `${contact.firstName} ${contact.lastName}`.trim();
  const dnc = contact.doNotContact;
  const active = contact.lifecycleState === "active";
  const openEnroll = (trigger?: WorkflowTrigger) => {
    setEnrollTrigger(trigger);
    setEnrollOpen(true);
  };
  const openCall = (taskId?: string) => {
    setDialogTaskId(taskId);
    setCallOpen(true);
  };

  const meetings = meetingList.data?.pages.flatMap((p) => p.data) ?? [];
  const proposals = proposalList.data?.pages.flatMap((p) => p.data) ?? [];
  const openTasks = taskList.data?.pages.flatMap((p) => p.data) ?? [];
  const runs = runList.data?.pages.flatMap((p) => p.data) ?? [];
  const scheduled = stepList.data?.pages.flatMap((p) => p.data) ?? [];
  const nextAutomationStep = scheduled
    .filter((a) => ["pending", "due"].includes(a.status))
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))[0];

  const completeTask = (task: { id: string; type: string; title: string }) => {
    if (task.type === "call") return openCall(task.id);
    if (task.type === "schedule_meeting") return setMeetingOpen(true);
    void completeTaskMutation.mutateAsync(task.id).then(
      () =>
        toastUndo(
          `“${task.title}” completed`,
          () => void mutate(() => reopenTask.mutateAsync(task.id), "Task reopened"),
        ),
      (error: unknown) => toast.error(messageFromError(error)),
    );
  };

  const quick = (icon: ReactNode, text: string, onClick: () => void, blockedByDnc = true) => (
    <Button
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={blockedByDnc && dnc}
      title={blockedByDnc && dnc ? DNC_HINT : undefined}
    >
      {icon} {text}
    </Button>
  );

  const meetingsAndProposals = (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="type-section-title">Meetings</CardTitle>
          <div className="flex items-center gap-2">
            <Link
              to="/meetings"
              search={{ contactId: id, view: "everyone", sort: "at:desc" }}
              className="type-small text-primary hover:underline"
            >
              View all
            </Link>
            <Button size="sm" variant="outline" disabled={dnc} onClick={() => setMeetingOpen(true)}>
              <CalendarPlus /> Schedule
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {meetings.length === 0 && (
            <p className="type-body text-muted-foreground">No meetings scheduled.</p>
          )}
          {meetings.map((m) => (
            <div
              key={m.id}
              className="flex flex-wrap items-start justify-between gap-2 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="type-body font-medium">{m.title}</div>
                <div className="type-small text-muted-foreground">
                  {fmtDateTime(m.at)} · {m.durationMin} min · {m.ownerName ?? "No owner"}
                  {m.deal && <> · Deal: {m.deal.name}</>}
                </div>
                {m.outcome && (
                  <div className="type-small text-muted-foreground">
                    Outcome: {label(m.outcome)}
                  </div>
                )}
                {m.meetLink && (
                  <a
                    href={m.meetLink}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 type-small text-primary hover:underline"
                  >
                    <Video className="size-3" /> Join Meet
                  </a>
                )}
                {m.calendarSyncStatus === "failed" && (
                  <div
                    className="mt-1 flex items-center gap-1 type-small text-destructive"
                    title={m.calendarSyncError}
                  >
                    <AlertTriangle className="size-3" /> Calendar sync failed
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge value={m.status} />
                {m.notifyEmailStatus && m.notifyEmailStatus !== "not_applicable" && (
                  <EmailStatusPill status={m.notifyEmailStatus} error={m.notifyEmailError} />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={m.status === "completed" || m.status === "cancelled"}
                  onClick={() => setOutcomeFor(m.id)}
                >
                  Record outcome
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="type-section-title">Proposals</CardTitle>
          <div className="flex items-center gap-2">
            <Link
              to="/proposals"
              search={{ contactId: id, view: "everyone" }}
              className="type-small text-primary hover:underline"
            >
              View all
            </Link>
            <Button
              size="sm"
              variant="outline"
              disabled={dnc}
              onClick={() => setProposalOpen(true)}
            >
              <FileText /> Send proposal
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {proposals.length === 0 && (
            <p className="type-body text-muted-foreground">No proposals yet.</p>
          )}
          {proposals.map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="type-body font-medium">{p.title}</div>
                <div className="type-small text-muted-foreground">
                  {p.fileName || "No document"} ·{" "}
                  {p.amount ? <Money amount={p.amount} currency={p.currency} /> : "No value"} ·
                  updated {relDay(p.updatedAt)}
                  {p.deal && <> · Deal: {p.deal.name}</>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge value={p.status} />
                {p.emailSendStatus !== "not_applicable" && (
                  <EmailStatusPill status={p.emailSendStatus} error={p.emailSendError} />
                )}
                <ViewDocumentButton proposal={p} />
                <Button size="sm" variant="ghost" onClick={() => setStatusFor(p)}>
                  Change status
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );

  const automation = (
    <div className="space-y-4">
      <LeadJourneyCard
        runs={runs}
        scheduledActions={scheduled}
        pipelineStage={contact.pipelineStage}
        doNotContact={dnc}
        onCallClick={() => openCall(callTaskId)}
        onEnrollClick={() =>
          openEnroll(nurtureTriggerForStage(contact.pipelineStage, contact.objectionType))
        }
      />
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="type-section-title">Automation control</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <StatusBadge value={contact.automationMode} dot />
          <div className="flex flex-wrap gap-2">
            {AUTOMATION_MODES.map((mode) => (
              <Button
                key={mode}
                size="sm"
                variant={contact.automationMode === mode ? "default" : "outline"}
                disabled={dnc}
                onClick={() =>
                  void mutate(
                    () =>
                      actions.setAutomation(
                        id,
                        mode as AutomationMode,
                        "Changed from contact record",
                      ),
                    `Automation set to ${label(mode)}`,
                  )
                }
              >
                {label(mode)}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="type-section-title">Workflow runs</CardTitle>
          <Button size="sm" variant="outline" disabled={dnc} onClick={() => openEnroll()}>
            Enroll in workflow
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {runs.length === 0 && (
            <p className="type-body text-muted-foreground">This contact is not in any workflow.</p>
          )}
          {runs.map((run) => (
            <div key={run.id} className="rounded-md border px-3 py-2">
              <div className="flex justify-between gap-2">
                <div className="type-body font-medium">
                  {run.workflow.name} · V{run.version}
                </div>
                <StatusBadge value={run.status} />
              </div>
              <div className="type-small text-muted-foreground">
                Current step: {currentStepText(run)}
                {run.nextRunAt ? ` · next ${relDay(run.nextRunAt)}` : ""}
              </div>
              {run.lastError && <div className="type-small text-destructive">{run.lastError}</div>}
            </div>
          ))}
          {runs.length > 0 && (
            <Link
              to="/automations/runs"
              search={{ contactId: id }}
              className="type-small text-primary hover:underline"
            >
              View all runs
            </Link>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="type-section-title">Scheduled actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {scheduled.length === 0 && (
            <p className="type-body text-muted-foreground">No scheduled actions.</p>
          )}
          {scheduled.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <div>
                <div className="type-body">{label(a.actionType)}</div>
                <div className="type-small text-muted-foreground">
                  {relDay(a.scheduledFor)}
                  {a.lastError ? ` · ${a.lastError}` : ""}
                </div>
              </div>
              <StatusBadge value={a.status} />
            </div>
          ))}
          {stepList.hasNextPage && (
            <Link
              to="/automations/runs"
              search={{ tab: "steps", contactId: id }}
              className="type-small text-primary hover:underline"
            >
              View all scheduled steps
            </Link>
          )}
        </CardContent>
      </Card>
    </div>
  );

  const callTaskId =
    contact.nextAction && ["call", "follow_up"].includes(contact.nextAction.type)
      ? contact.nextAction.taskId
      : undefined;
  // "Note" goes to the composer (no dialog); on phones with another tab open, the dialog.
  const focusNote = () => {
    const box = document.querySelector<HTMLTextAreaElement>('[aria-label="New note"]');
    if (box) box.focus();
    else setNoteOpen(true);
  };
  const contactability = extras.contactability;
  const blockers = contactability.filter(
    (c) => c.status === "opted_out" || (c.channel === "email" && c.status in EMAIL_BLOCKED),
  );

  const quickActions = (
    <>
      {quick(<Phone />, "Log call", () => openCall(callTaskId))}
      {quick(<StickyNote />, "Note", focusNote, false)}
      {quick(<ClipboardList />, "Task", () => createTask.open({ contact: { id, name } }))}
      {quick(<CalendarPlus />, "Meeting", () => setMeetingOpen(true))}
      {quick(<FileText />, "Proposal", () => setProposalOpen(true))}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            More <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={dnc} onSelect={() => setMessageOpen(true)}>
            <MessageSquare /> Log email / WhatsApp
          </DropdownMenuItem>
          <DropdownMenuItem disabled={dnc} onSelect={() => openEnroll()}>
            Enroll in workflow
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {active ? (
            <>
              <DropdownMenuItem
                onSelect={() =>
                  void mutate(() => actions.setLifecycle(id, "won"), "Contact marked Won")
                }
              >
                Mark won
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLostOpen(true)}>Mark lost…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDiscardOpen(true)}>Discard…</DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  void mutate(
                    () => actions.setLifecycle(id, "long_term_nurture"),
                    "Moved to Long-Term Nurture",
                  )
                }
              >
                Long-term nurture
              </DropdownMenuItem>
            </>
          ) : (
            !dnc &&
            contact.lifecycleState !== "merged" && (
              <DropdownMenuItem
                onSelect={() =>
                  void mutate(() => actions.setLifecycle(id, "reactivate"), "Contact reactivated")
                }
              >
                Reactivate
              </DropdownMenuItem>
            )
          )}
          <DropdownMenuSeparator />
          {dnc ? (
            <DropdownMenuItem onSelect={() => setReactivateOpen(true)}>
              Remove DNC…
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => setDncOpen(true)}>Mark DNC…</DropdownMenuItem>
          )}
          <DropdownMenuItem className="text-destructive" onSelect={() => setDeleteOpen(true)}>
            Delete forever…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 items-start gap-3">
        <UserAvatar name={name} className="size-10 text-sm" />
        <div className="min-w-0">
          <h1 className="type-page-title truncate">{name}</h1>
          <p className="truncate type-small text-muted-foreground">
            {contact.jobTitle}
            {contact.jobTitle && (contact.company || contact.companyText) && " · "}
            {contact.company ? (
              <RecordLink
                type="company"
                id={contact.company.id}
                className="text-primary hover:underline"
              >
                {contact.company.name}
              </RecordLink>
            ) : (
              contact.companyText
            )}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <InlineOwner
              label="Owner"
              users={users}
              value={
                contact.ownerId ? { id: contact.ownerId, name: contact.ownerName ?? "" } : null
              }
              onChange={(ownerId) =>
                void mutate(() => actions.updateLead(id, { ownerId }), "Owner updated")
              }
            />
            <StatusBadge value={contact.pipelineStage} />
            {!active && <StatusBadge value={contact.lifecycleState} />}
            <HotScorePill
              score={contact.hotScore}
              band={contact.hotBand}
              reasons={contact.hotReasons}
            />
            {contact.agentStatus !== "none" && (
              <StatusBadge
                value=""
                display={`AI: ${AGENT_STATUS_LABEL[contact.agentStatus]}`}
                tone={AGENT_STATUS_TONE[contact.agentStatus]}
              />
            )}
            {contact.whatsappNumber && (
              <StatusPill tone="neutral">WhatsApp · {contact.whatsappNumber.label}</StatusPill>
            )}
            {blockers.map((c) => (
              <StatusPill key={c.channel} tone="danger">
                {label(c.channel)}: {EMAIL_BLOCKED[c.status] ?? "Opted out"}
              </StatusPill>
            ))}
            {dnc && contact.lifecycleState !== "do_not_contact" && (
              <StatusPill tone="danger">Do Not Contact</StatusPill>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{quickActions}</div>
    </div>
  );

  // The one next step, above the composer: visible without scrolling on a laptop.
  const nextStrip = (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2",
        !contact.nextAction && !nextAutomationStep && !dnc && "border-warning/50 bg-warning-soft",
      )}
    >
      <div className="min-w-0 type-body">
        <span className="mr-2 type-label">Next</span>
        {contact.nextAction ? (
          <>
            <span className="font-medium">{contact.nextAction.title}</span>
            <span className="type-small text-muted-foreground">
              {" "}
              · {label(contact.nextAction.type)} · due{" "}
              <span className={isOverdue(contact.nextAction.dueAt) ? "text-destructive" : ""}>
                {relDay(contact.nextAction.dueAt)}
              </span>{" "}
              · {contact.nextAction.ownerName ?? userName(contact.nextAction.ownerId)}
            </span>
          </>
        ) : nextAutomationStep ? (
          <span>
            Automated: {label(nextAutomationStep.actionType)}{" "}
            <span className="type-small text-muted-foreground">
              · workflow step · due {relDay(nextAutomationStep.scheduledFor)}
            </span>
          </span>
        ) : (
          <span>
            {dnc
              ? "Contact is suppressed - no next action required."
              : "No next action assigned. Every active contact needs one."}
          </span>
        )}
      </div>
      <div className="flex gap-1.5">
        {contact.nextAction && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              completeTask({
                id: contact.nextAction!.taskId,
                type: contact.nextAction!.type,
                title: contact.nextAction!.title,
              })
            }
          >
            <Check /> Complete
          </Button>
        )}
        <Button size="sm" onClick={() => setNextActionOpen(true)} disabled={dnc}>
          {contact.nextAction ? "Reschedule" : "Set next action"}
        </Button>
      </div>
    </div>
  );

  const main = (
    <>
      {nextStrip}
      <RecordComposer
        contactId={id}
        canCall={!dnc}
        callTaskId={callTaskId}
        onConnected={() => openCall(callTaskId)}
      />
      <ActivityFeed
        key={linkKey}
        contactId={id}
        initialFilter={link.activity}
        focusReply={link.reply === "latest"}
      />
    </>
  );

  const stageDetails = (
    <>
      {contact.pipelineStage === "interested_later" && (
        <div className="space-y-1 rounded-md bg-muted/50 p-2.5 type-small text-muted-foreground">
          <p className="font-medium text-foreground">Interested - Later</p>
          {contact.interestedLaterReason && <p>Reason: {contact.interestedLaterReason}</p>}
          {contact.interestedLaterRestartAt && (
            <p>Expected restart: {contact.interestedLaterRestartAt}</p>
          )}
          {contact.interestedLaterNextAction && (
            <p>Next action: {contact.interestedLaterNextAction}</p>
          )}
          {contact.interestedLaterDecisionOwner && (
            <p>Decision owner: {contact.interestedLaterDecisionOwner}</p>
          )}
          {!contact.interestedLaterReason && !contact.interestedLaterRestartAt && (
            <p>Captured from the call outcome. Log a call to update it.</p>
          )}
        </div>
      )}
      {contact.pipelineStage === "objection_nurture" && contact.objectionType && (
        <p className="type-body">
          Objection: <StatusBadge value={contact.objectionType} />
        </p>
      )}
      {contact.lifecycleState === "lost" && contact.lossReason && (
        <div className="type-body">
          Loss reason: <StatusBadge value={contact.lossReason} />
          {contact.lossCompetitorName && <span> · {contact.lossCompetitorName}</span>}
          {contact.lossNotes && (
            <p className="pt-1 type-small text-muted-foreground">{contact.lossNotes}</p>
          )}
          {contact.recoverAt && !contact.recoveredAt && (
            <p className="pt-1 type-small text-muted-foreground">
              Comes back for re-engagement on {fmtDate(contact.recoverAt)}
            </p>
          )}
        </div>
      )}
      {contact.lifecycleState === "discarded" && contact.discardReason && (
        <p className="type-body">
          Discarded: <StatusBadge value={contact.discardReason} />
        </p>
      )}
    </>
  );

  const tasksCard = (
    <div className="space-y-2">
      {openTasks.length === 0 && <p className="type-body text-muted-foreground">No open tasks.</p>}
      {openTasks.map((task) => (
        <div key={task.id} className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="type-body">{task.title}</div>
            <div className="flex flex-wrap items-center gap-1.5 type-small text-muted-foreground">
              {label(task.type)} ·{" "}
              <span className={task.isOverdue ? "text-destructive" : ""}>{relDay(task.dueAt)}</span>
              <TaskOriginBadge origin={task.origin} />
            </div>
          </div>
          <div className="flex shrink-0 gap-0.5">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Complete ${task.title}`}
              onClick={() => completeTask(task)}
            >
              <Check />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void mutate(() => cancelTask.mutateAsync({ id: task.id }), "Task cancelled")
              }
            >
              Cancel
            </Button>
          </div>
        </div>
      ))}
      <Link
        to="/tasks"
        search={{ contactId: id, view: "everyone" }}
        className="type-small text-primary hover:underline"
      >
        View all tasks
      </Link>
    </div>
  );

  const openDeals = contact.deals.filter((d) => !d.closedAt);
  const rail: RailCard[] = [
    {
      id: "about",
      title: "About",
      content: (
        <div className="space-y-3">
          {stageDetails}
          <ContactAbout
            contact={contact}
            contactability={contactability}
            omit={["whatsappNumber", "hotScore", "contactability-whatsapp"]}
          />
        </div>
      ),
    },
    {
      id: "company",
      title: "Company",
      action: (
        <Button size="sm" variant="ghost" onClick={() => setChangeCompanyOpen(true)}>
          Change
        </Button>
      ),
      content: (
        <ContactAssociations
          contact={contact}
          show="company"
          changeOpen={changeCompanyOpen}
          onChangeOpen={setChangeCompanyOpen}
        />
      ),
    },
    {
      id: "deals",
      title: "Open deals",
      badge: openDeals.length,
      action: (
        <Button
          size="sm"
          variant="ghost"
          aria-label="Create deal"
          onClick={() => createDeal.open({ contact: { id, name }, stay: true })}
        >
          <Plus /> Deal
        </Button>
      ),
      content: <ContactAssociations contact={contact} show="deals" />,
    },
    { id: "tasks", title: "Next tasks", badge: openTasks.length, content: tasksCard },
    {
      id: "ai",
      title: "AI",
      content: (
        <div className="space-y-3">
          <LatestSuggestedReply contactId={id} openOnly />
          <LeadAiPanel leadId={id} />
        </div>
      ),
    },
    {
      id: "hot",
      title: "Hot-score reasons",
      content: <ContactAbout contact={contact} contactability={[]} only={["hotScore"]} />,
    },
    {
      id: "whatsapp",
      title: "WhatsApp number",
      content: (
        <ContactAbout
          contact={contact}
          contactability={contactability.filter((c) => c.channel === "whatsapp")}
          only={["whatsappNumber", "contactability-whatsapp"]}
        />
      ),
    },
    {
      id: "meetings",
      title: "Meetings & proposals",
      badge: meetings.length + proposals.length,
      defaultOpen: false,
      content: meetingsAndProposals,
    },
    { id: "automation", title: "Automation", defaultOpen: false, content: automation },
  ];

  return (
    <>
      <RecordShell
        railKey="contact"
        breadcrumb={<RecordBreadcrumb list="/contacts" label="Contacts" name={name} />}
        header={header}
        banner={
          dnc && (
            <div
              role="status"
              className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/25 bg-danger-soft px-4 py-2.5 text-danger-soft-foreground sm:mx-6"
            >
              <div className="type-body">
                <span className="font-semibold">Do Not Contact.</span>{" "}
                {[contact.dncReason, contact.dncBy].filter(Boolean).join(" · ")}
                {contact.dncAt && <> · {relDay(contact.dncAt)}</>}
              </div>
              <Button size="sm" variant="outline" onClick={() => setReactivateOpen(true)}>
                Remove suppression
              </Button>
            </div>
          )
        }
        main={main}
        rail={rail}
      />
      <LogCallFlow
        leadId={id}
        taskId={dialogTaskId}
        open={callOpen}
        onOpenChange={(value) => {
          setCallOpen(value);
          if (!value) setDialogTaskId(undefined);
        }}
      />
      <ScheduleMeetingFlow leadId={id} open={meetingOpen} onOpenChange={setMeetingOpen} />
      <EnrollWorkflowDialog
        leadId={id}
        open={enrollOpen}
        onOpenChange={(value) => {
          setEnrollOpen(value);
          if (!value) setEnrollTrigger(undefined);
        }}
        {...(enrollTrigger ? { triggerFilter: enrollTrigger } : {})}
      />
      <SendProposalDialog
        leadId={id}
        open={proposalOpen}
        onOpenChange={setProposalOpen}
        onSend={(value) =>
          createProposal.mutateAsync({
            leadId: id,
            title: value.title,
            validUntil: value.validUntil || undefined,
            amount: value.amount ? Number(value.amount) : undefined,
            notes: value.notes || undefined,
            emailTemplateId: value.emailTemplateId,
            whatsappTemplateId: value.whatsappTemplateId,
            document: value.document,
          })
        }
      />
      <NextActionDialog
        open={nextActionOpen}
        onOpenChange={setNextActionOpen}
        defaultOwner={contact.ownerId ?? ""}
        {...(contact.nextAction
          ? {
              initial: {
                taskId: contact.nextAction.taskId,
                type: contact.nextAction.type,
                title: contact.nextAction.title,
                dueAt: contact.nextAction.dueAt,
                ownerId: contact.nextAction.ownerId ?? contact.ownerId ?? "",
              },
            }
          : {})}
        onSave={(value) =>
          void mutate(
            () =>
              contact.nextAction
                ? updateTask.mutateAsync({ id: contact.nextAction.taskId, input: value })
                : createTaskMutation.mutateAsync({ leadId: id, ...value }),
            "Next action saved",
          )
        }
      />
      <ProposalStatusDialog
        key={statusFor?.id ?? "none"}
        proposal={statusFor}
        open={Boolean(statusFor)}
        onOpenChange={(open) => !open && setStatusFor(null)}
      />
      <OutcomeDialog
        open={Boolean(outcomeFor)}
        onOpenChange={(open) => !open && setOutcomeFor(null)}
        onSave={(outcome, notesText) => {
          if (!outcomeFor) return;
          void mutate(async () => {
            await recordOutcome.mutateAsync({
              id: outcomeFor,
              outcome,
              notes: notesText || undefined,
            });
            setOutcomeFor(null);
          }, "Outcome recorded");
        }}
      />
      <NoteDialog
        open={noteOpen}
        onOpenChange={setNoteOpen}
        onSave={(body) => mutate(() => actions.addNote(id, body), "Note added")}
      />
      <LogMessageDialog
        open={messageOpen}
        onOpenChange={setMessageOpen}
        onSave={(channel, detail) =>
          mutate(
            () => actions.logCommunication(id, channel, detail),
            `${channel === "email" ? "Email" : "WhatsApp"} logged`,
          )
        }
      />
      <ReasonDialog
        open={dncOpen}
        title="Mark Do Not Contact"
        action="This stops automation and cancels inappropriate actions."
        value={reason}
        onValue={setReason}
        onOpenChange={setDncOpen}
        onConfirm={() =>
          void mutate(async () => {
            await actions.markDnc(id, reason.trim());
            setDncOpen(false);
            setReason("");
          }, "Contact suppressed")
        }
      />
      <ReasonDialog
        open={reactivateOpen}
        title="Remove Do Not Contact"
        action="A reason is required and suppression history remains preserved."
        value={reason}
        onValue={setReason}
        onOpenChange={setReactivateOpen}
        onConfirm={() =>
          void mutate(async () => {
            await actions.reactivateFromDnc(id, reason.trim());
            setReactivateOpen(false);
            setReason("");
          }, "Contact reactivated")
        }
      />
      <LostReasonDialog
        open={lostOpen}
        lossReason={lossReason}
        onLossReason={setLossReason}
        notes={lossNotes}
        onNotes={setLossNotes}
        details={lossDetails}
        onDetails={setLossDetails}
        onOpenChange={setLostOpen}
        onConfirm={() =>
          void mutate(async () => {
            await actions.setLifecycle(id, "lost", lossNotes.trim() || undefined, {
              lossReason: lossReason || undefined,
              competitorName: lossDetails.competitorName.trim() || undefined,
              projectDate: lossDetails.projectDate || undefined,
            });
            setLostOpen(false);
            setLossReason("");
            setLossNotes("");
            setLossDetails({ competitorName: "", projectDate: "" });
          }, "Contact marked Lost")
        }
      />
      <DiscardDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        onConfirm={(discardReason, text) =>
          void mutate(async () => {
            await actions.setLifecycle(id, "discard", text || undefined, { discardReason });
            setDiscardOpen(false);
          }, "Contact discarded")
        }
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${name} forever?`}
        description="This permanently deletes the contact and everything attached to it - calls, tasks, meetings, proposals, notes and the activity timeline. This cannot be undone."
        confirmLabel="Delete forever"
        disabled={deleting}
        onConfirm={() =>
          void (async () => {
            setDeleting(true);
            try {
              await actions.deleteLead(id);
              toast.success("Contact deleted");
              setDeleteOpen(false);
              void navigate({ to: "/contacts" });
            } catch (error) {
              toast.error(messageFromError(error));
            } finally {
              setDeleting(false);
            }
          })()
        }
      />
    </>
  );
}

/** Logs an email/WhatsApp the rep sent outside the CRM. Never sends anything. */
function LogMessageDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (channel: "email" | "whatsapp", detail?: string) => Promise<boolean>;
}) {
  const [channel, setChannel] = useState<"email" | "whatsapp">("email");
  const [detail, setDetail] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log email / WhatsApp</DialogTitle>
        </DialogHeader>
        <p className="type-small text-muted-foreground">
          Records a message you sent yourself on the timeline. Nothing is sent from here.
        </p>
        <div className="space-y-3">
          <div>
            <Label htmlFor="log-channel" className="mb-1.5 block text-xs">
              Channel
            </Label>
            <Select value={channel} onValueChange={(v) => setChannel(v as "email" | "whatsapp")}>
              <SelectTrigger id="log-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="log-detail" className="mb-1.5 block text-xs">
              What was sent (optional)
            </Label>
            <Textarea
              id="log-detail"
              rows={3}
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              void onSave(channel, detail.trim() || undefined).then((ok) => {
                if (!ok) return;
                setDetail("");
                onOpenChange(false);
              })
            }
          >
            Log it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
