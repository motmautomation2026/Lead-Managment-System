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
import { PageHeader } from "@/components/crm/page-header";
import { RecordLayout } from "@/components/crm/record-layout";
import { UserAvatar } from "@/components/crm/user-avatar";
import { EmptyState } from "@/components/crm/empty-state";
import { RelativeTime } from "@/components/crm/relative-time";
import { Money } from "@/components/crm/money";
import { LeadAiPanel } from "@/features/agent/lead-ai-panel";
import { LeadJourneyCard } from "@/features/leads/lead-journey-card";
import { LogCallDialog } from "@/features/leads/log-call-dialog";
import { EnrollWorkflowDialog } from "@/features/leads/scheduled-followups";
import { LostReasonDialog, NextActionDialog, ReasonDialog } from "@/features/leads/lead-dialogs";
import { ScheduleMeetingDialog } from "@/features/meetings/schedule-meeting-dialog";
import { OutcomeDialog } from "@/features/meetings/meetings-page";
import { SendProposalDialog } from "@/features/proposals/components/send-proposal-dialog";
import { BackendError } from "@/lib/backend-client";
import { fmtDateTime, isOverdue, relDay } from "@/lib/format";
import { label } from "@/lib/labels";
import { nurtureTriggerForStage } from "@/lib/pipeline";
import { findCurrentStep } from "@/lib/workflow-timeline";
import {
  messageFromError,
  useAutomations,
  useContact,
  useLead,
  useLeadMutations,
  useMeetings,
  useProposals,
  useSession,
  useTasks,
} from "@/store";
import {
  AUTOMATION_MODES,
  PROPOSAL_STATUSES,
  type AutomationMode,
  type ContactDetail,
  type LeadLossReason,
  type ProposalStatus,
  type WorkflowTrigger,
} from "@/types";
import { ContactAbout } from "./contact-about";
import { ContactActivity } from "./contact-activity";
import { ContactAssociations } from "./contact-associations";

const DNC_HINT = "This contact is Do Not Contact. Remove the suppression first.";

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
export function ContactRecordPage({ contactId }: { contactId: string }) {
  const query = useContact(contactId);
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
  return <ContactRecord contact={query.data} />;
}

function ContactRecord({ contact }: { contact: ContactDetail }) {
  const id = contact.id;
  const navigate = useNavigate();
  const { users, userName } = useSession();
  const actions = useLeadMutations();
  const extras = useLead(id);
  const taskStore = useTasks();
  const meetingStore = useMeetings();
  const proposalStore = useProposals();
  const automationStore = useAutomations();

  const [callOpen, setCallOpen] = useState(false);
  const [callTaskId, setCallTaskId] = useState<string | undefined>(undefined);
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [savingMeeting, setSavingMeeting] = useState(false);
  // Meeting Agreed: enroll only after the meeting is actually saved.
  const [pendingTrigger, setPendingTrigger] = useState<WorkflowTrigger | undefined>(undefined);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollTrigger, setEnrollTrigger] = useState<WorkflowTrigger | undefined>(undefined);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [taskDialog, setTaskDialog] = useState<"next" | "new" | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  const [outcomeFor, setOutcomeFor] = useState<string | null>(null);
  const [dncOpen, setDncOpen] = useState(false);
  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [lostOpen, setLostOpen] = useState(false);
  const [lossReason, setLossReason] = useState<LeadLossReason | "">("");
  const [lossNotes, setLossNotes] = useState("");
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
    setCallTaskId(taskId);
    setCallOpen(true);
  };

  const meetings = meetingStore.meetings.filter((m) => m.leadId === id);
  const proposals = proposalStore.proposals.filter((p) => p.leadId === id);
  const openTasks = taskStore.tasks.filter((t) => t.leadId === id && t.status === "open");
  const runs = automationStore.runs.filter((r) => r.leadId === id);
  const scheduled = automationStore.scheduledActions.filter((a) => a.leadId === id);
  const nextAutomationStep = scheduled
    .filter((a) => ["pending", "due"].includes(a.status))
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))[0];
  const dealName = (dealId?: string | null) =>
    contact.deals.find((d) => d.id === dealId)?.name ?? null;

  const completeTask = (task: { id: string; type: string }) => {
    if (task.type === "call") return openCall(task.id);
    if (task.type === "schedule_meeting") return setMeetingOpen(true);
    void mutate(() => taskStore.completeTask(task.id), "Task completed");
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

  const heading = (
    <div className="flex min-w-0 items-start gap-3">
      <UserAvatar name={name} className="size-12 text-base" />
      <div className="min-w-0">
        <h1 className="type-page-title break-words">{name}</h1>
        <p className="type-body text-muted-foreground">
          {[contact.jobTitle, contact.company?.name ?? contact.companyText]
            .filter(Boolean)
            .join(" · ") || "–"}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusBadge value={contact.pipelineStage} />
          <StatusBadge value={contact.lifecycleState} />
          <Select
            value={contact.ownerId ?? ""}
            onValueChange={(ownerId) =>
              void mutate(() => actions.updateLead(id, { ownerId }), "Owner updated")
            }
          >
            <SelectTrigger className="h-7 w-auto gap-1.5 text-xs" aria-label="Owner">
              <UserAvatar name={contact.ownerName} size="sm" className="size-5" />
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              {users
                .filter((u) => u.active || u.id === contact.ownerId)
                .map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );

  const quickActions = (
    <>
      {quick(<Phone />, "Log call", () => openCall(undefined))}
      {quick(<StickyNote />, "Note", () => setNoteOpen(true), false)}
      {quick(<CalendarPlus />, "Meeting", () => setMeetingOpen(true))}
      {quick(<ClipboardList />, "Task", () => setTaskDialog("new"))}
      {quick(<FileText />, "Proposal", () => setProposalOpen(true))}
      {quick(<MessageSquare />, "Log email / WhatsApp", () => setMessageOpen(true))}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            More <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
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
              <DropdownMenuItem
                onSelect={() =>
                  void mutate(() => actions.setLifecycle(id, "discard"), "Contact discarded")
                }
              >
                Discard
              </DropdownMenuItem>
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

  const overview = (
    <div className="space-y-4">
      <LeadJourneyCard
        leadId={id}
        pipelineStage={contact.pipelineStage}
        doNotContact={dnc}
        onCallClick={() =>
          openCall(contact.nextAction?.type === "call" ? contact.nextAction.taskId : undefined)
        }
        onEnrollClick={() =>
          openEnroll(nurtureTriggerForStage(contact.pipelineStage, contact.objectionType))
        }
      />
      <Card className={contact.nextAction || nextAutomationStep ? "" : "border-warning/50"}>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div>
            <div className="type-label">Next action</div>
            {contact.nextAction ? (
              <>
                <div className="type-section-title">{contact.nextAction.title}</div>
                <div className="type-small text-muted-foreground">
                  {label(contact.nextAction.type)} · due{" "}
                  <span className={isOverdue(contact.nextAction.dueAt) ? "text-destructive" : ""}>
                    {relDay(contact.nextAction.dueAt)}
                  </span>{" "}
                  · {contact.nextAction.ownerName ?? userName(contact.nextAction.ownerId)}
                </div>
              </>
            ) : nextAutomationStep ? (
              <>
                <div className="type-section-title">
                  Automated: {label(nextAutomationStep.actionType)}
                </div>
                <div className="type-small text-muted-foreground">
                  Workflow step · due {relDay(nextAutomationStep.scheduledFor)}
                </div>
              </>
            ) : (
              <div className="type-body">
                {dnc
                  ? "Contact is suppressed - no next action required."
                  : "No next action assigned. Every active contact needs one."}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            {contact.nextAction && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  completeTask({ id: contact.nextAction!.taskId, type: contact.nextAction!.type })
                }
              >
                <Check /> Complete
              </Button>
            )}
            <Button size="sm" onClick={() => setTaskDialog("next")} disabled={dnc}>
              {contact.nextAction ? "Reschedule" : "Set next action"}
            </Button>
          </div>
        </CardContent>
      </Card>
      {contact.pipelineStage === "interested_later" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="type-section-title">Interested - Later</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 type-small text-muted-foreground">
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
          </CardContent>
        </Card>
      )}
      {contact.pipelineStage === "objection_nurture" && contact.objectionType && (
        <Card>
          <CardContent className="py-4 type-body">
            Objection: <StatusBadge value={contact.objectionType} />
          </CardContent>
        </Card>
      )}
      {contact.lifecycleState === "lost" && contact.lossReason && (
        <Card>
          <CardContent className="py-4 type-body">
            Loss reason: <StatusBadge value={contact.lossReason} />
            {contact.lossNotes && (
              <p className="pt-1 type-small text-muted-foreground">{contact.lossNotes}</p>
            )}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="type-section-title">Open tasks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {openTasks.length === 0 && (
            <p className="type-body text-muted-foreground">No open tasks.</p>
          )}
          {openTasks.map((task) => (
            <div
              key={task.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="type-body">{task.title}</div>
                <div className="flex flex-wrap items-center gap-1.5 type-small text-muted-foreground">
                  {label(task.type)} ·{" "}
                  <span className={isOverdue(task.dueAt) ? "text-destructive" : ""}>
                    {relDay(task.dueAt)}
                  </span>
                  <TaskOriginBadge origin={task.origin} />
                </div>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => completeTask(task)}>
                  Complete
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void mutate(() => taskStore.cancelTask(task.id), "Task cancelled")}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );

  const notes = (
    <div className="space-y-3">
      <NoteForm onSave={(body) => mutate(() => actions.addNote(id, body), "Note added")} />
      {extras.notes.length === 0 && <EmptyState title="No notes yet" />}
      {extras.notes.map((item) => (
        <Card key={item.id}>
          <CardContent className="py-3">
            <div className="type-body whitespace-pre-wrap">{item.body}</div>
            <div className="pt-1 type-small text-muted-foreground">
              {item.author} · {relDay(item.at)}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );

  const meetingsAndProposals = (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="type-section-title">Meetings</CardTitle>
          <Button size="sm" variant="outline" disabled={dnc} onClick={() => setMeetingOpen(true)}>
            <CalendarPlus /> Schedule
          </Button>
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
                  {fmtDateTime(m.at)} · {m.durationMin} min · {m.ownerName ?? userName(m.ownerId)}
                  {dealName(m.dealId) && <> · Deal: {dealName(m.dealId)}</>}
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
              <div className="flex items-center gap-2">
                <StatusBadge value={m.status} />
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
          <Button size="sm" variant="outline" disabled={dnc} onClick={() => setProposalOpen(true)}>
            <FileText /> Send proposal
          </Button>
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
                  {dealName(p.dealId) && <> · Deal: {dealName(p.dealId)}</>}
                </div>
              </div>
              <Select
                value={p.status}
                disabled={proposalStore.isPending}
                onValueChange={(status) =>
                  void mutate(
                    () => proposalStore.setProposalStatus(p.id, status as ProposalStatus),
                    `Proposal marked ${label(status)}`,
                  )
                }
              >
                <SelectTrigger className="h-8 w-44" aria-label={`Status of ${p.title}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROPOSAL_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {label(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );

  const automation = (
    <div className="space-y-4">
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
          {runs.map((run) => {
            const workflow = automationStore.workflows.find((w) => w.id === run.workflowId);
            const step = findCurrentStep(workflow, run);
            return (
              <div key={run.id} className="rounded-md border px-3 py-2">
                <div className="flex justify-between gap-2">
                  <div className="type-body font-medium">
                    {workflow?.name ?? run.workflowId} · V{run.version}
                  </div>
                  <StatusBadge value={run.status} />
                </div>
                <div className="type-small text-muted-foreground">
                  Current step:{" "}
                  {step
                    ? label(step.action)
                    : ["running", "waiting"].includes(run.status)
                      ? "No enabled steps configured"
                      : "-"}
                  {run.nextRunAt ? ` · next ${relDay(run.nextRunAt)}` : ""}
                </div>
                {run.lastError && (
                  <div className="type-small text-destructive">{run.lastError}</div>
                )}
              </div>
            );
          })}
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
        </CardContent>
      </Card>
    </div>
  );

  return (
    <div className="pb-10">
      <PageHeader title={name} heading={heading} actions={quickActions} />
      {dnc && (
        <div
          role="status"
          className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/25 bg-danger-soft px-4 py-3 text-danger-soft-foreground sm:mx-6"
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
      )}
      <RecordLayout
        left={<ContactAbout contact={contact} contactability={extras.contactability} />}
        tabs={[
          { id: "overview", label: "Overview", content: overview },
          { id: "activity", label: "Activity", content: <ContactActivity leadId={id} /> },
          { id: "notes", label: "Notes", content: notes },
          { id: "meetings", label: "Meetings & proposals", content: meetingsAndProposals },
          { id: "automation", label: "Automation", content: automation },
        ]}
        defaultTab="overview"
        right={
          <>
            <ContactAssociations contact={contact} />
            <LeadAiPanel leadId={id} />
          </>
        }
        rightLabel="Associations"
      />

      <LogCallDialog
        leadId={id}
        taskId={callTaskId}
        open={callOpen}
        onOpenChange={(value) => {
          setCallOpen(value);
          if (!value) setCallTaskId(undefined);
        }}
        onEnrollPrompt={openEnroll}
        onScheduleMeetingPrompt={(trigger) => {
          setPendingTrigger(trigger);
          setMeetingOpen(true);
        }}
      />
      <ScheduleMeetingDialog
        leadId={id}
        meeting={null}
        open={meetingOpen}
        isSaving={savingMeeting}
        onOpenChange={(value) => {
          setMeetingOpen(value);
          if (!value) setPendingTrigger(undefined);
        }}
        onSave={(value) =>
          void (async () => {
            setSavingMeeting(true);
            try {
              await meetingStore.addMeeting(value);
              toast.success("Meeting scheduled");
              setMeetingOpen(false);
              // Scheduling cancels the contact's runs, so enroll only after it.
              if (pendingTrigger) {
                openEnroll(pendingTrigger);
                setPendingTrigger(undefined);
              }
            } catch (error) {
              toast.error(messageFromError(error));
            } finally {
              setSavingMeeting(false);
            }
          })()
        }
      />
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
          proposalStore.addProposal({
            leadId: id,
            title: value.title,
            amount: value.amount ? Number(value.amount) : undefined,
            notes: value.notes || undefined,
            emailTemplateId: value.emailTemplateId,
            whatsappTemplateId: value.whatsappTemplateId,
            document: value.document,
          })
        }
      />
      <NextActionDialog
        open={taskDialog !== null}
        onOpenChange={(open) => !open && setTaskDialog(null)}
        defaultOwner={contact.ownerId ?? ""}
        {...(taskDialog === "next" && contact.nextAction
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
              taskDialog === "next" && contact.nextAction
                ? taskStore.updateTask(contact.nextAction.taskId, value)
                : taskStore.addTask({ leadId: id, ...value }),
            taskDialog === "next" ? "Next action saved" : "Task created",
          )
        }
      />
      <OutcomeDialog
        open={Boolean(outcomeFor)}
        onOpenChange={(open) => !open && setOutcomeFor(null)}
        onSave={(outcome, notesText) => {
          if (!outcomeFor) return;
          void mutate(async () => {
            await meetingStore.recordOutcome(outcomeFor, outcome, notesText);
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
        onOpenChange={setLostOpen}
        onConfirm={() =>
          void mutate(async () => {
            await actions.setLifecycle(
              id,
              "lost",
              lossNotes.trim() || undefined,
              lossReason || undefined,
            );
            setLostOpen(false);
            setLossReason("");
            setLossNotes("");
          }, "Contact marked Lost")
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
    </div>
  );
}

function NoteForm({ onSave }: { onSave: (body: string) => Promise<boolean> }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <Textarea
          rows={3}
          value={note}
          aria-label="New note"
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note…"
        />
        <Button
          size="sm"
          disabled={!note.trim() || saving}
          onClick={() => {
            setSaving(true);
            void onSave(note.trim())
              .then((ok) => ok && setNote(""))
              .finally(() => setSaving(false));
          }}
        >
          Add note
        </Button>
      </CardContent>
    </Card>
  );
}

function NoteDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (body: string) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add note</DialogTitle>
        </DialogHeader>
        <Textarea
          rows={4}
          value={body}
          aria-label="Note"
          onChange={(e) => setBody(e.target.value)}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!body.trim()}
            onClick={() =>
              void onSave(body.trim()).then((ok) => {
                if (!ok) return;
                setBody("");
                onOpenChange(false);
              })
            }
          >
            Add note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
