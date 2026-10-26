import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  backend,
  type AgentDecisionFilters,
  type AgentEnrollResult,
  type AgentRatingInput,
  type AgentSettingsUpdate,
  type CreateLeadInput,
  type CreateMeetingInput,
  type CreateProposalInput,
  type CreateTaskInput,
  type CreateTemplateInput,
  type CreateWorkflowInput,
  type ImportLeadRow,
  type LogCallInput,
  type UpdateLeadInput,
  type UpdateMeetingInput,
  type UpdateProposalInput,
  type UpdateTaskInput,
  type UpdateTemplateInput,
  type UpdateWorkflowInput,
} from "@/lib/backend-client";
import { initials } from "@/lib/format";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import type {
  AutomationMode,
  ActivityType,
  BulkResult,
  CompanyInput,
  CompanyListParams,
  ContactListParams,
  DealListParams,
  DuplicateListParams,
  CreateDealInput,
  MoveDealStageInput,
  UpdateDealInput,
  SavedViewInput,
  SavedViewObject,
  LeadLossReason,
  MeetingOutcome,
  ProposalStatus,
  TemplateType,
  User,
  WorkflowStep,
} from "@/types";
import { keys, refreshCompany, refreshContact, refreshDeal } from "./query";
import { useWorkspace } from "./workspace-context";

export function useSession() {
  const me = useQuery({
    queryKey: keys.session,
    queryFn: ({ signal }) => backend.me(signal),
    staleTime: 60_000,
  });
  const profiles = useQuery({
    queryKey: keys.profiles,
    queryFn: ({ signal }) => backend.profiles(signal),
    staleTime: 60_000,
  });
  const users: User[] = (profiles.data?.data ?? []).map((user) => ({
    ...user,
    role: user.role === "admin" ? "Admin" : "Salesperson",
  }));
  const currentUser: User | null = me.data
    ? {
        id: me.data.id,
        name: me.data.name,
        email: me.data.email,
        initials: initials(me.data.name),
        active: true,
        role: me.data.role === "admin" ? "Admin" : "Salesperson",
      }
    : null;
  return {
    users,
    currentUser,
    userName: (id?: string) => users.find((user) => user.id === id)?.name ?? "Unassigned",
    isLoading: me.isLoading || profiles.isLoading,
    error: me.error ?? profiles.error,
  };
}
export type SessionSlice = ReturnType<typeof useSession>;

/** The one check for admin-only UI (role from GET /me); the backend enforces it with requireAdmin. */
export function useIsAdmin() {
  return useSession().currentUser?.role === "Admin";
}

/** The old ≤500-row leads list (old pages and lead pickers only; never for one contact — B11). */
export function useLeadList(enabled = true) {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.leads(currentWorkspaceId),
    queryFn: ({ signal }) => backend.leads.list({ limit: 500 }, signal),
    enabled: enabled && Boolean(currentWorkspaceId),
  });
}

export function useLeads() {
  const query = useLeadList();
  const leads = query.data?.data ?? [];
  return {
    ...useLeadMutations(),
    leads,
    getLead: (id: string) => leads.find((lead) => lead.id === id),
    isLoading: query.isLoading,
    error: query.error,
  };
}
export type LeadsSlice = ReturnType<typeof useLeads>;

/** Every lead/contact write (PATCH /leads/:id, notes, calls, lifecycle…) without loading a list. */
export function useLeadMutations() {
  const client = useQueryClient();
  const { currentWorkspaceId } = useWorkspace();
  const refresh = (leadId: string) => refreshContact(client, currentWorkspaceId, leadId);
  const create = useMutation({
    mutationFn: (input: CreateLeadInput) => backend.leads.create(input),
    onSuccess: (lead) => refresh(lead.id),
  });
  const importCsv = useMutation({
    mutationFn: (rows: ImportLeadRow[]) => backend.leads.importCsv(rows),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.leads(currentWorkspaceId) }),
        client.invalidateQueries({ queryKey: keys.dashboard(currentWorkspaceId) }),
        client.invalidateQueries({ queryKey: keys.notifications(currentWorkspaceId) }),
      ]),
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLeadInput }) =>
      backend.leads.update(id, input),
    onSuccess: (lead) => refresh(lead.id),
  });
  const note = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => backend.leads.addNote(id, body),
    onSuccess: (_, vars) => refresh(vars.id),
  });
  const remove = useMutation({
    mutationFn: (id: string) => backend.leads.delete(id),
    onSuccess: (_, id) => refresh(id),
  });
  const automation = useMutation({
    mutationFn: ({
      id,
      mode,
      reason,
    }: {
      id: string;
      mode: AutomationMode;
      reason?: string | undefined;
    }) => backend.leads.setAutomation(id, mode, reason),
    onSuccess: (lead) => refresh(lead.id),
  });
  const dnc = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      backend.leads.markDnc(id, reason),
    onSuccess: (lead) => refresh(lead.id),
  });
  const dncReactivate = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      backend.leads.reactivateFromDnc(id, reason),
    onSuccess: (lead) => refresh(lead.id),
  });
  const call = useMutation({
    mutationFn: ({ id, input }: { id: string; input: LogCallInput }) =>
      backend.leads.logCall(id, input),
    onSuccess: (result) => refresh(result.lead.id),
  });
  const communication = useMutation({
    mutationFn: ({
      id,
      channel,
      detail,
    }: {
      id: string;
      channel: "email" | "whatsapp";
      detail?: string | undefined;
    }) => backend.leads.logCommunication(id, channel, detail),
    onSuccess: (_, vars) => refresh(vars.id),
  });
  const lifecycle = useMutation({
    mutationFn: ({
      id,
      action,
      reason,
      lossReason,
    }: {
      id: string;
      action: "won" | "lost" | "discard" | "reactivate" | "long_term_nurture";
      reason?: string | undefined;
      /** Required by the backend when action === 'lost'. */
      lossReason?: LeadLossReason | undefined;
    }) =>
      action === "won"
        ? backend.leads.markWon(id, reason)
        : action === "lost"
          ? backend.leads.markLost(id, lossReason!, reason)
          : action === "discard"
            ? backend.leads.discard(id, reason)
            : action === "long_term_nurture"
              ? backend.leads.longTermNurture(id, reason)
              : backend.leads.reactivate(id, reason),
    onSuccess: (lead) => refresh(lead.id),
  });
  const isPending = [
    create,
    importCsv,
    update,
    remove,
    note,
    automation,
    dnc,
    dncReactivate,
    call,
    communication,
    lifecycle,
  ].some((mutation) => mutation.isPending);
  return {
    isPending,
    addLead: (input: CreateLeadInput) => create.mutateAsync(input),
    importLeadsCsv: (rows: ImportLeadRow[]) => importCsv.mutateAsync(rows),
    updateLead: (id: string, input: UpdateLeadInput) => update.mutateAsync({ id, input }),
    deleteLead: (id: string) => remove.mutateAsync(id),
    addNote: (id: string, body: string) => note.mutateAsync({ id, body }),
    setAutomation: (id: string, mode: AutomationMode, reason?: string) =>
      automation.mutateAsync({ id, mode, reason }),
    markDnc: (id: string, reason: string) => dnc.mutateAsync({ id, reason }),
    reactivateFromDnc: (id: string, reason: string) => dncReactivate.mutateAsync({ id, reason }),
    logCall: (id: string, input: LogCallInput) => call.mutateAsync({ id, input }),
    logCommunication: (id: string, channel: "email" | "whatsapp", detail?: string) =>
      communication.mutateAsync({ id, channel, detail }),
    setLifecycle: (
      id: string,
      action: "won" | "lost" | "discard" | "reactivate" | "long_term_nurture",
      reason?: string,
      lossReason?: LeadLossReason,
    ) => lifecycle.mutateAsync({ id, action, reason, lossReason }),
  };
}

export function useLead(leadId: string) {
  const { currentWorkspaceId } = useWorkspace();
  const enabled = Boolean(leadId) && Boolean(currentWorkspaceId);
  const lead = useQuery({
    queryKey: keys.lead(currentWorkspaceId, leadId),
    queryFn: ({ signal }) => backend.leads.get(leadId, signal),
    enabled,
  });
  const notes = useQuery({
    queryKey: keys.notes(currentWorkspaceId, leadId),
    queryFn: ({ signal }) => backend.leads.notes(leadId, signal),
    enabled,
  });
  const contactability = useQuery({
    queryKey: keys.contactability(currentWorkspaceId, leadId),
    queryFn: ({ signal }) => backend.leads.contactability(leadId, signal),
    enabled,
  });
  return {
    lead: lead.data,
    notes: notes.data?.data ?? [],
    contactability: contactability.data?.data ?? [],
    isLoading: lead.isLoading || notes.isLoading || contactability.isLoading,
    error: lead.error ?? notes.error ?? contactability.error,
  };
}

export function useTasks() {
  const client = useQueryClient();
  const { currentWorkspaceId } = useWorkspace();
  const query = useQuery({
    queryKey: keys.tasks(currentWorkspaceId),
    queryFn: ({ signal }) => backend.tasks.list(undefined, signal),
    enabled: Boolean(currentWorkspaceId),
  });
  const refresh = (leadId: string) => refreshContact(client, currentWorkspaceId, leadId);
  const create = useMutation({
    mutationFn: (input: CreateTaskInput) => backend.tasks.create(input),
    onSuccess: (task) => refresh(task.leadId),
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTaskInput }) =>
      backend.tasks.update(id, input),
    onSuccess: (task) => refresh(task.leadId),
  });
  const complete = useMutation({
    mutationFn: (id: string) => backend.tasks.complete(id),
    onSuccess: (task) => refresh(task.leadId),
  });
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string | undefined }) =>
      backend.tasks.cancel(id, reason),
    onSuccess: (task) => refresh(task.leadId),
  });
  return {
    tasks: query.data?.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    isPending: create.isPending || update.isPending || complete.isPending || cancel.isPending,
    addTask: (input: CreateTaskInput) => create.mutateAsync(input),
    updateTask: (id: string, input: UpdateTaskInput) => update.mutateAsync({ id, input }),
    completeTask: (id: string) => complete.mutateAsync(id),
    cancelTask: (id: string, reason?: string) => cancel.mutateAsync({ id, reason }),
  };
}
export type TasksSlice = ReturnType<typeof useTasks>;

export function useMeetings() {
  const client = useQueryClient();
  const { currentWorkspaceId } = useWorkspace();
  const query = useQuery({
    queryKey: keys.meetings(currentWorkspaceId),
    queryFn: ({ signal }) => backend.meetings.list(undefined, signal),
    enabled: Boolean(currentWorkspaceId),
  });
  const refresh = (leadId: string) => refreshContact(client, currentWorkspaceId, leadId);
  const create = useMutation({
    mutationFn: (input: CreateMeetingInput) => backend.meetings.create(input),
    onSuccess: (meeting) => refresh(meeting.leadId),
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMeetingInput }) =>
      backend.meetings.update(id, input),
    onSuccess: (meeting) => refresh(meeting.leadId),
  });
  const outcome = useMutation({
    mutationFn: ({
      id,
      outcome,
      notes,
    }: {
      id: string;
      outcome: MeetingOutcome;
      notes?: string | undefined;
    }) => backend.meetings.recordOutcome(id, outcome, notes),
    onSuccess: (meeting) => refresh(meeting.leadId),
  });
  return {
    meetings: query.data?.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    isPending: create.isPending || update.isPending || outcome.isPending,
    addMeeting: (input: CreateMeetingInput) => create.mutateAsync(input),
    updateMeeting: (id: string, input: UpdateMeetingInput) => update.mutateAsync({ id, input }),
    recordOutcome: (id: string, value: MeetingOutcome, notes?: string) =>
      outcome.mutateAsync({ id, outcome: value, notes }),
  };
}
export type MeetingsSlice = ReturnType<typeof useMeetings>;

export function useProposals() {
  const client = useQueryClient();
  const { currentWorkspaceId } = useWorkspace();
  const query = useQuery({
    queryKey: keys.proposals(currentWorkspaceId),
    queryFn: ({ signal }) => backend.proposals.list(undefined, signal),
    enabled: Boolean(currentWorkspaceId),
    // Keeps polling while any proposal's WhatsApp send is still in flight on
    // the worker (email resolves synchronously, but WhatsApp can only be
    // sent from the automation worker process — see Backend/src/worker.ts —
    // so its status flips a few seconds after this list first loads).
    refetchInterval: (q) =>
      q.state.data?.data.some((p) => ["queued", "sending"].includes(p.whatsappSendStatus))
        ? 8000
        : false,
  });
  const refresh = (leadId: string) => refreshContact(client, currentWorkspaceId, leadId);
  const create = useMutation({
    mutationFn: (input: CreateProposalInput) => backend.proposals.create(input),
    onSuccess: (proposal) => refresh(proposal.leadId),
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateProposalInput }) =>
      backend.proposals.update(id, input),
    onSuccess: (proposal) => refresh(proposal.leadId),
  });
  const status = useMutation({
    mutationFn: ({
      id,
      status,
      lossReason,
      lossNotes,
    }: {
      id: string;
      status: ProposalStatus;
      lossReason?: LeadLossReason | undefined;
      lossNotes?: string | undefined;
    }) => backend.proposals.setStatus(id, status, lossReason, lossNotes),
    onSuccess: (proposal) => refresh(proposal.leadId),
  });
  return {
    proposals: query.data?.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    isPending: create.isPending || update.isPending || status.isPending,
    addProposal: (input: CreateProposalInput) => create.mutateAsync(input),
    updateProposal: (id: string, input: UpdateProposalInput) => update.mutateAsync({ id, input }),
    // lossReason/lossNotes are required by the backend when value is
    // 'rejected'/'expired' — the UI prompts for it first (see
    // proposals-page.tsx) rather than this hook silently omitting it.
    setProposalStatus: (
      id: string,
      value: ProposalStatus,
      lossReason?: LeadLossReason,
      lossNotes?: string,
    ) => status.mutateAsync({ id, status: value, lossReason, lossNotes }),
  };
}
export type ProposalsSlice = ReturnType<typeof useProposals>;

export function useTimeline(leadId: string) {
  const { currentWorkspaceId } = useWorkspace();
  const query = useQuery({
    queryKey: keys.timeline(currentWorkspaceId, leadId),
    queryFn: ({ signal }) => backend.leads.timeline(leadId, signal),
    enabled: Boolean(leadId) && Boolean(currentWorkspaceId),
  });
  return { timeline: query.data?.data ?? [], isLoading: query.isLoading, error: query.error };
}
export type TimelineSlice = ReturnType<typeof useTimeline>;

export function useAutomations() {
  const client = useQueryClient();
  const { currentWorkspaceId } = useWorkspace();
  const enabled = Boolean(currentWorkspaceId);
  const workflows = useQuery({
    queryKey: keys.workflows(currentWorkspaceId),
    queryFn: ({ signal }) => backend.workflows.list(signal),
    enabled,
  });
  const templates = useQuery({
    queryKey: keys.templates(currentWorkspaceId),
    queryFn: ({ signal }) => backend.templates.list(signal),
    enabled,
  });
  const runs = useQuery({
    queryKey: keys.runs(currentWorkspaceId),
    queryFn: ({ signal }) => backend.runs.list(undefined, signal),
    enabled,
  });
  const scheduled = useQuery({
    queryKey: keys.scheduledActions(currentWorkspaceId),
    queryFn: ({ signal }) => backend.scheduledActions.list(undefined, signal),
    enabled,
  });
  const invalidate = () =>
    Promise.all(
      [
        keys.workflows(currentWorkspaceId),
        keys.templates(currentWorkspaceId),
        keys.runs(currentWorkspaceId),
        keys.scheduledActions(currentWorkspaceId),
        keys.dashboard(currentWorkspaceId),
      ].map((queryKey) => client.invalidateQueries({ queryKey })),
    );
  const workflowCreate = useMutation({
    mutationFn: (input: CreateWorkflowInput) => backend.workflows.create(input),
    onSuccess: invalidate,
  });
  const workflowUpdate = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateWorkflowInput }) =>
      backend.workflows.update(id, input),
    onSuccess: invalidate,
  });
  const draft = useMutation({
    mutationFn: (id: string) => backend.workflows.createDraft(id),
    onSuccess: invalidate,
  });
  const steps = useMutation({
    mutationFn: ({ id, version, steps }: { id: string; version: number; steps: WorkflowStep[] }) =>
      backend.workflows.updateSteps(id, version, steps),
    onSuccess: invalidate,
  });
  const publish = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      backend.workflows.publish(id, version),
    onSuccess: invalidate,
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => backend.workflows.duplicate(id),
    onSuccess: invalidate,
  });
  const workflowDelete = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      backend.workflows.delete(id, force),
    onSuccess: invalidate,
  });
  const workflowVersionDelete = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      backend.workflows.deleteVersion(id, version),
    onSuccess: invalidate,
  });
  // Runs change the contact's next action, timeline and tasks too (audit B31).
  const invalidateFor = (leadId: string) =>
    Promise.all([invalidate(), refreshContact(client, currentWorkspaceId, leadId)]);
  const runAction = useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: "pause" | "resume" | "cancel" | "retry";
    }) =>
      action === "pause"
        ? backend.runs.pause(id)
        : action === "resume"
          ? backend.runs.resume(id)
          : action === "cancel"
            ? backend.runs.cancel(id)
            : backend.runs.retry(id),
    onSuccess: (run) => invalidateFor(run.leadId),
  });
  const enroll = useMutation({
    mutationFn: (input: { leadId: string; workflowId: string; reason?: string | undefined }) =>
      backend.runs.create(input),
    onSuccess: (_, input) => invalidateFor(input.leadId),
  });
  const templateCreate = useMutation({
    mutationFn: (input: CreateTemplateInput) => backend.templates.create(input),
    onSuccess: invalidate,
  });
  const templateUpdate = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTemplateInput }) =>
      backend.templates.update(id, input),
    onSuccess: invalidate,
  });
  const templateDelete = useMutation({
    mutationFn: (id: string) => backend.templates.delete(id),
    onSuccess: invalidate,
  });
  const templateAttachmentUpload = useMutation({
    mutationFn: ({ templateId, file }: { templateId: string; file: File }) =>
      backend.templates.uploadAttachment(templateId, file),
    onSuccess: invalidate,
  });
  const templateAttachmentDelete = useMutation({
    mutationFn: ({ templateId, attachmentId }: { templateId: string; attachmentId: string }) =>
      backend.templates.deleteAttachment(templateId, attachmentId),
    onSuccess: invalidate,
  });
  const workflowList = workflows.data?.data ?? [];
  return {
    workflows: workflowList,
    templates: templates.data?.data ?? [],
    runs: runs.data?.data ?? [],
    scheduledActions: scheduled.data?.data ?? [],
    isLoading: workflows.isLoading || templates.isLoading || runs.isLoading || scheduled.isLoading,
    error: workflows.error ?? templates.error ?? runs.error ?? scheduled.error,
    isPending: [
      workflowCreate,
      workflowUpdate,
      draft,
      steps,
      publish,
      duplicate,
      workflowDelete,
      workflowVersionDelete,
      runAction,
      enroll,
      templateCreate,
      templateUpdate,
      templateDelete,
      templateAttachmentUpload,
      templateAttachmentDelete,
    ].some((mutation) => mutation.isPending),
    templateName: (id?: string) =>
      templates.data?.data.find((template) => template.id === id)?.name ?? "-",
    addWorkflow: (input: CreateWorkflowInput) => workflowCreate.mutateAsync(input),
    updateWorkflow: (id: string, input: UpdateWorkflowInput) =>
      workflowUpdate.mutateAsync({ id, input }),
    createDraft: async (id: string) => {
      const workflow = await draft.mutateAsync(id);
      return (
        workflow.versions.find((version) => version.status === "draft")?.version ??
        workflow.currentVersion
      );
    },
    updateDraftSteps: (id: string, version: number, value: WorkflowStep[]) =>
      steps.mutateAsync({ id, version, steps: value }),
    publishVersion: (id: string, version: number) => publish.mutateAsync({ id, version }),
    duplicateWorkflow: (id: string) => duplicate.mutateAsync(id),
    deleteWorkflow: (id: string, force?: boolean) =>
      workflowDelete.mutateAsync(force !== undefined ? { id, force } : { id }),
    deleteWorkflowVersion: (id: string, version: number) =>
      workflowVersionDelete.mutateAsync({ id, version }),
    pauseRun: (id: string) => runAction.mutateAsync({ id, action: "pause" }),
    resumeRun: (id: string) => runAction.mutateAsync({ id, action: "resume" }),
    cancelRun: (id: string) => runAction.mutateAsync({ id, action: "cancel" }),
    retryRun: (id: string) => runAction.mutateAsync({ id, action: "retry" }),
    enrollLead: (leadId: string, workflowId: string, reason?: string) =>
      enroll.mutateAsync({ leadId, workflowId, reason }),
    addTemplate: (input: { name: string; type: TemplateType; subject: string; body: string }) =>
      templateCreate.mutateAsync({
        name: input.name,
        channel: input.type,
        subject: input.subject,
        body: input.body,
      }),
    updateTemplate: (id: string, input: UpdateTemplateInput) =>
      templateUpdate.mutateAsync({ id, input }),
    deleteTemplate: (id: string) => templateDelete.mutateAsync(id),
    uploadTemplateAttachment: (templateId: string, file: File) =>
      templateAttachmentUpload.mutateAsync({ templateId, file }),
    deleteTemplateAttachment: (templateId: string, attachmentId: string) =>
      templateAttachmentDelete.mutateAsync({ templateId, attachmentId }),
  };
}
export type AutomationsSlice = ReturnType<typeof useAutomations>;

export function useNotifications() {
  const client = useQueryClient();
  const { currentWorkspaceId } = useWorkspace();
  const query = useQuery({
    queryKey: keys.notifications(currentWorkspaceId),
    queryFn: ({ signal }) => backend.notifications.list(signal),
    enabled: Boolean(currentWorkspaceId),
  });
  const readAll = useMutation({
    mutationFn: () => backend.notifications.markAllRead(),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.notifications(currentWorkspaceId) }),
  });
  return {
    notifications: query.data?.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    markNotificationsRead: () => readAll.mutateAsync(),
  };
}
export type NotificationsSlice = ReturnType<typeof useNotifications>;

export function useDashboard() {
  const { currentWorkspaceId } = useWorkspace();
  const query = useQuery({
    queryKey: keys.dashboard(currentWorkspaceId),
    queryFn: ({ signal }) => backend.dashboard.summary(signal),
    enabled: Boolean(currentWorkspaceId),
  });
  return { summary: query.data, isLoading: query.isLoading, error: query.error };
}

const KNOWLEDGE_POLL_MS = 5_000;

/** Poll while anything is still being ingested by the worker; stop once all are ready or failed. */
export function knowledgePollInterval(
  items: { status: string | null }[] | undefined,
): number | false {
  return items?.some((item) => item.status === "pending" || item.status === "processing")
    ? KNOWLEDGE_POLL_MS
    : false;
}

export function useKnowledge() {
  const client = useQueryClient();
  const { currentWorkspaceId } = useWorkspace();
  const enabled = Boolean(currentWorkspaceId);
  const documents = useQuery({
    queryKey: keys.knowledgeDocuments(currentWorkspaceId),
    queryFn: ({ signal }) => backend.knowledge.documents.list(signal),
    enabled,
    refetchInterval: (query) => knowledgePollInterval(query.state.data?.data),
  });
  const assets = useQuery({
    queryKey: keys.knowledgeAssets(currentWorkspaceId),
    queryFn: ({ signal }) => backend.knowledge.assets.list(signal),
    enabled,
    refetchInterval: (query) => knowledgePollInterval(query.state.data?.data),
  });
  const invalidate = () =>
    Promise.all(
      [keys.knowledgeDocuments(currentWorkspaceId), keys.knowledgeAssets(currentWorkspaceId)].map(
        (queryKey) => client.invalidateQueries({ queryKey }),
      ),
    );
  const write =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      const result = await fn(...args);
      await invalidate();
      return result;
    };
  return {
    documents: documents.data?.data ?? [],
    assets: assets.data?.data ?? [],
    isLoading: documents.isLoading || assets.isLoading,
    error: documents.error ?? assets.error,
    createText: write(backend.knowledge.documents.createText),
    upload: write(backend.knowledge.documents.upload),
    updateDocument: write(backend.knowledge.documents.update),
    reprocess: write(backend.knowledge.documents.reprocess),
    removeDocument: write(backend.knowledge.documents.remove),
    createAsset: write(backend.knowledge.assets.create),
    updateAsset: write(backend.knowledge.assets.update),
    removeAsset: write(backend.knowledge.assets.remove),
  };
}

export function useKnowledgeDocument(id: string | null) {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.knowledgeDocument(currentWorkspaceId, id ?? ""),
    queryFn: ({ signal }) => backend.knowledge.documents.get(id!, signal),
    enabled: Boolean(currentWorkspaceId && id),
  });
}

export function useKnowledgeSearch() {
  return useMutation({ mutationFn: backend.knowledge.search });
}

// --- AI agent (Settings → AI agent, admin only) ---------------------------------

export function useAgentSettings() {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.agentSettings(currentWorkspaceId),
    queryFn: ({ signal }) => backend.agent.settings.get(signal),
    enabled: Boolean(currentWorkspaceId),
  });
}

export function useUpdateAgentSettings() {
  const client = useQueryClient();
  const { currentWorkspaceId } = useWorkspace();
  return useMutation({
    mutationFn: (input: AgentSettingsUpdate) => backend.agent.settings.update(input),
    onSuccess: (data) => client.setQueryData(keys.agentSettings(currentWorkspaceId), data),
  });
}

export function useAgentPlaybooks() {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.agentPlaybooks(currentWorkspaceId),
    queryFn: ({ signal }) => backend.agent.playbooks.list(signal),
    enabled: Boolean(currentWorkspaceId),
  });
}

/** A new playbook version also changes settings.currentPlaybookVersion. */
function usePlaybookWrite<A>(fn: (arg: A) => Promise<unknown>) {
  const client = useQueryClient();
  const { currentWorkspaceId } = useWorkspace();
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      Promise.all(
        [keys.agentPlaybooks(currentWorkspaceId), keys.agentSettings(currentWorkspaceId)].map(
          (queryKey) => client.invalidateQueries({ queryKey }),
        ),
      ),
  });
}

export const useSavePlaybook = () =>
  usePlaybookWrite((body: string) => backend.agent.playbooks.create(body));
export const useRestorePlaybook = () =>
  usePlaybookWrite((version: number) => backend.agent.playbooks.restore(version));

// --- AI decision review (AI Activity page, lead AI panel; any CRM user) ----------

export function useAgentDecisions(filters: AgentDecisionFilters) {
  const { currentWorkspaceId } = useWorkspace();
  return useInfiniteQuery({
    queryKey: keys.agentDecisions(currentWorkspaceId, filters),
    queryFn: ({ pageParam, signal }) => backend.agent.decisions.list(filters, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(currentWorkspaceId),
  });
}

export function useAgentDecision(id: string | null) {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.agentDecision(currentWorkspaceId, id ?? ""),
    queryFn: ({ signal }) => backend.agent.decisions.get(id!, signal),
    enabled: Boolean(currentWorkspaceId && id),
  });
}

export function useAgentStats() {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.agentStats(currentWorkspaceId),
    queryFn: ({ signal }) => backend.agent.stats(signal),
    enabled: Boolean(currentWorkspaceId),
  });
}

export function useLeadAgentPanel(leadId: string) {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.agentLeadPanel(currentWorkspaceId, leadId),
    queryFn: ({ signal }) => backend.agent.leads.panel(leadId, signal),
    enabled: Boolean(currentWorkspaceId && leadId),
  });
}

/** A rating, report or resolve: the decision, every decisions list, stats and the lead panels. */
function useReviewWrite<A>(fn: (arg: A) => Promise<{ decisionId?: string; id: string }>) {
  const client = useQueryClient();
  const { currentWorkspaceId: ws } = useWorkspace();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) =>
      Promise.all(
        [
          keys.agentDecision(ws, result.decisionId ?? result.id),
          keys.agentDecisions(ws),
          keys.agentStats(ws),
          keys.agentLeadPanel(ws),
        ].map((queryKey) => client.invalidateQueries({ queryKey })),
      ),
  });
}

export const useRateDecision = () =>
  useReviewWrite(({ id, input }: { id: string; input: AgentRatingInput }) =>
    backend.agent.decisions.rate(id, input),
  );
export const useReportDecision = () =>
  useReviewWrite(({ id, note }: { id: string; note: string }) =>
    backend.agent.decisions.report(id, note),
  );
export const useResolveReport = () =>
  useReviewWrite(({ reportId, note }: { reportId: string; note?: string | undefined }) =>
    backend.agent.resolveReport(reportId, note),
  );

const ENROLL_CHUNK = 100;

/** Admin: agent status changes refresh the contact(s) (refreshContact) and the AI stats. */
function useAgentStatusWrite<A, R>(
  fn: (arg: A) => Promise<R>,
  leadIdOf: (arg: A) => string | null,
) {
  const client = useQueryClient();
  const { currentWorkspaceId: ws } = useWorkspace();
  return useMutation({
    mutationFn: fn,
    onSuccess: (_, arg) =>
      Promise.all([
        refreshContact(client, ws, leadIdOf(arg) ?? undefined),
        client.invalidateQueries({ queryKey: keys.agentStats(ws) }),
      ]),
  });
}

/** Sends the ids in chunks of 100, one after another; returns every result. */
export const useEnrollLeads = () =>
  useAgentStatusWrite(
    async (leadIds: string[]) => {
      const results: AgentEnrollResult[] = [];
      for (let i = 0; i < leadIds.length; i += ENROLL_CHUNK) {
        results.push(
          ...(await backend.agent.leads.enroll(leadIds.slice(i, i + ENROLL_CHUNK))).data,
        );
      }
      return results;
    },
    (leadIds) => (leadIds.length === 1 ? leadIds[0]! : null),
  );
export const usePauseLead = () =>
  useAgentStatusWrite(
    (leadId: string) => backend.agent.leads.pause(leadId),
    (id) => id,
  );
export const useResumeLead = () =>
  useAgentStatusWrite(
    (leadId: string) => backend.agent.leads.resume(leadId),
    (id) => id,
  );
export const useStopLead = () =>
  useAgentStatusWrite(
    ({ leadId, note }: { leadId: string; note?: string | undefined }) =>
      backend.agent.leads.stop(leadId, note),
    ({ leadId }) => leadId,
  );
export const useWakeLead = () =>
  useAgentStatusWrite(
    (leadId: string) => backend.agent.leads.wake(leadId),
    (id) => id,
  );

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 250;

/** Global search (GET /search): debounced 250 ms, runs from 2 characters, per workspace. */
export function useGlobalSearch(input: string) {
  const { currentWorkspaceId } = useWorkspace();
  const q = useDebouncedValue(input.trim(), SEARCH_DEBOUNCE_MS);
  const enabled = Boolean(currentWorkspaceId) && q.length >= SEARCH_MIN_CHARS;
  const result = useQuery({
    queryKey: keys.search(currentWorkspaceId, q),
    queryFn: ({ signal }) => backend.search(q, signal),
    enabled,
    staleTime: 30_000,
  });
  return {
    ...result,
    query: q,
    enabled,
    /** Typing has not settled yet, or the request is in flight. */
    isSearching: input.trim() !== q || (enabled && result.isFetching),
  };
}

// --- CRM v2 contacts (B4; UI says Contact, rows are leads) --------------------------

export function useContacts(params: ContactListParams) {
  const { currentWorkspaceId } = useWorkspace();
  return useInfiniteQuery({
    queryKey: keys.contacts(currentWorkspaceId, params),
    queryFn: ({ pageParam, signal }) => backend.contacts.list(params, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(currentWorkspaceId),
  });
}

/** Same filters as `useContacts` (sort is not allowed on /count). */
export function useContactsCount(params: ContactListParams) {
  const { currentWorkspaceId } = useWorkspace();
  const { sort: _sort, ...filters } = params;
  return useQuery({
    queryKey: keys.contactsCount(currentWorkspaceId, filters),
    queryFn: ({ signal }) => backend.contacts.count(filters, signal),
    enabled: Boolean(currentWorkspaceId),
  });
}

export function useContact(id: string) {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.contact(currentWorkspaceId, id),
    queryFn: ({ signal }) => backend.contacts.get(id, signal),
    enabled: Boolean(currentWorkspaceId && id),
  });
}

const BULK_CHUNK = 100;

/** POST /contacts/bulk in chunks of 100, one after another; returns every per-id result. */
export function useBulkContacts() {
  const client = useQueryClient();
  const { currentWorkspaceId: ws } = useWorkspace();
  return useMutation({
    mutationFn: async (input: {
      ids: string[];
      action: "assignOwner" | "enrollAi";
      ownerId?: string;
    }) => {
      const results: BulkResult[] = [];
      for (let i = 0; i < input.ids.length; i += BULK_CHUNK) {
        const ids = input.ids.slice(i, i + BULK_CHUNK);
        results.push(...(await backend.contacts.bulk({ ...input, ids })).data);
      }
      return results;
    },
    onSuccess: () =>
      Promise.all([
        refreshContact(client, ws),
        client.invalidateQueries({ queryKey: keys.agentStats(ws) }),
      ]),
  });
}

export function useSavedViews(object: SavedViewObject) {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.savedViews(currentWorkspaceId, object),
    queryFn: ({ signal }) => backend.savedViews.list(object, signal),
    enabled: Boolean(currentWorkspaceId),
  });
}

function useSavedViewWrite<A, R>(fn: (arg: A) => Promise<R>) {
  const client = useQueryClient();
  const { currentWorkspaceId: ws } = useWorkspace();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => client.invalidateQueries({ queryKey: ["savedViews", ws] }),
  });
}

export const useCreateSavedView = () =>
  useSavedViewWrite((input: Parameters<typeof backend.savedViews.create>[0]) =>
    backend.savedViews.create(input),
  );
export const useUpdateSavedView = () =>
  useSavedViewWrite(({ id, input }: { id: string; input: SavedViewInput }) =>
    backend.savedViews.update(id, input),
  );
export const useDeleteSavedView = () =>
  useSavedViewWrite((id: string) => backend.savedViews.delete(id));

/** Company picker / "matches an existing company" hint: debounced, from 2 characters, top 5. */
export function useCompanySearch(input: string) {
  const { currentWorkspaceId } = useWorkspace();
  const q = useDebouncedValue(input.trim(), SEARCH_DEBOUNCE_MS);
  return useQuery({
    queryKey: keys.companySearch(currentWorkspaceId, q),
    queryFn: ({ signal }) => backend.companies.list({ q, limit: 5 }, undefined, signal),
    enabled: Boolean(currentWorkspaceId) && q.length >= SEARCH_MIN_CHARS,
    staleTime: 30_000,
  });
}

export function useCompany(id: string | null | undefined) {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.company(currentWorkspaceId, id ?? ""),
    queryFn: ({ signal }) => backend.companies.get(id!, signal),
    enabled: Boolean(currentWorkspaceId && id),
  });
}

/** POST /leads (a new contact) without loading the old 500-row leads list. */
export function useCreateContact() {
  const client = useQueryClient();
  const { currentWorkspaceId: ws } = useWorkspace();
  return useMutation({
    mutationFn: (input: CreateLeadInput) => backend.leads.create(input),
    onSuccess: (lead) => refreshContact(client, ws, lead.id),
  });
}

// --- CRM v2 companies + duplicate review (C3) -------------------------------------

/** One keyset list: `{data, nextCursor}` pages, enabled once a workspace is selected. */
function useCursorList<T>(
  queryKey: readonly unknown[],
  fetchPage: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ data: T[]; nextCursor: string | null }>,
  enabled = true,
) {
  const { currentWorkspaceId } = useWorkspace();
  return useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(currentWorkspaceId) && enabled,
  });
}

export function useCompanies(params: CompanyListParams) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCursorList(keys.companies(ws, params), (cursor, signal) =>
    backend.companies.list(params, cursor, signal),
  );
}

/** Same filters as `useCompanies` (sort/limit are not allowed on /count). */
export function useCompaniesCount(params: CompanyListParams) {
  const { currentWorkspaceId } = useWorkspace();
  const { sort: _sort, limit: _limit, ...filters } = params;
  return useQuery({
    queryKey: keys.companiesCount(currentWorkspaceId, filters),
    queryFn: ({ signal }) => backend.companies.count(filters, signal),
    enabled: Boolean(currentWorkspaceId),
  });
}

/** Industry filter options (cached 5 min; refreshed with every company list). */
export function useCompanyIndustries() {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.companyIndustries(currentWorkspaceId),
    queryFn: ({ signal }) => backend.companies.industries(signal),
    enabled: Boolean(currentWorkspaceId),
    staleTime: 300_000,
  });
}

export function useCompanyContacts(companyId: string, params: ContactListParams) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCursorList(
    keys.companyContacts(ws, companyId, params),
    (cursor, signal) => backend.companies.contacts(companyId, params, cursor, signal),
    Boolean(companyId),
  );
}

export function useCompanyDeals(companyId: string, params: DealListParams) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCursorList(
    keys.companyDeals(ws, companyId, params),
    (cursor, signal) => backend.companies.deals(companyId, params, cursor, signal),
    Boolean(companyId),
  );
}

/** The company feed, newest first; `kind` filters server-side (empty = all). */
export function useCompanyTimeline(companyId: string, kind: ActivityType[] = []) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCursorList(
    keys.companyTimeline(ws, companyId, { kind }),
    (cursor, signal) => backend.companies.timeline(companyId, kind, cursor, signal),
    Boolean(companyId),
  );
}

/** A contact's timeline, newest first, paginated; `kind` filters server-side (empty = all). */
export function useContactTimeline(leadId: string, kind: ActivityType[] = []) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCursorList(
    keys.contactTimeline(ws, leadId, { kind }),
    (cursor, signal) => backend.contacts.timeline(leadId, kind, cursor, signal),
    Boolean(leadId),
  );
}

function useCompanyWrite<A, R>(fn: (arg: A) => Promise<R>) {
  const client = useQueryClient();
  const { currentWorkspaceId: ws } = useWorkspace();
  return useMutation({ mutationFn: fn, onSuccess: () => refreshCompany(client, ws) });
}

export const useCreateCompany = () =>
  useCompanyWrite((input: CompanyInput & { name: string }) => backend.companies.create(input));
export const useUpdateCompany = () =>
  useCompanyWrite(({ id, input }: { id: string; input: CompanyInput }) =>
    backend.companies.update(id, input),
  );
/** Admin: `targetId` stays, `sourceId` is merged into it. */
export const useMergeCompanies = () =>
  useCompanyWrite(({ targetId, sourceId }: { targetId: string; sourceId: string }) =>
    backend.companies.merge(targetId, sourceId),
  );

export function useCompanyDuplicates(params: DuplicateListParams, enabled = true) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCursorList(
    keys.companyDuplicates(ws, params),
    (cursor, signal) => backend.companyDuplicates.list(params, cursor, signal),
    enabled,
  );
}

/** Admin only (pass `enabled: isAdmin`): open duplicate counts for buttons and the nav badge, cached 60 s. */
export function useCompanyDuplicatesCount(params: DuplicateListParams, enabled = true) {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.companyDuplicatesCount(currentWorkspaceId, params),
    queryFn: ({ signal }) => backend.companyDuplicates.count(params, signal),
    enabled: Boolean(currentWorkspaceId) && enabled,
    staleTime: 60_000,
  });
}

export const useMergeDuplicate = () =>
  useCompanyWrite(({ id, targetId }: { id: string; targetId?: string }) =>
    backend.companyDuplicates.merge(id, targetId),
  );
export const useDismissDuplicate = () =>
  useCompanyWrite((id: string) => backend.companyDuplicates.dismiss(id));
export const useRelinkDuplicate = () =>
  useCompanyWrite(({ id, companyId }: { id: string; companyId?: string }) =>
    backend.companyDuplicates.relink(id, companyId),
  );

// --- CRM v2 deals (C4) -------------------------------------------------------------

export function useDeals(params: DealListParams, enabled = true) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCursorList(
    keys.dealList(ws, params),
    (cursor, signal) => backend.deals.list(params, cursor, signal),
    enabled,
  );
}

/** Same filters as `useDeals` (sort/limit are not allowed on /count). */
export function useDealsCount(params: DealListParams) {
  const { currentWorkspaceId } = useWorkspace();
  const { sort: _sort, limit: _limit, ...filters } = params;
  return useQuery({
    queryKey: keys.dealCount(currentWorkspaceId, filters),
    queryFn: ({ signal }) => backend.deals.count(filters, signal),
    enabled: Boolean(currentWorkspaceId),
  });
}

/** The pipeline board (every stage; `stage`, `sort` and `limit` are not sent). */
export function useDealBoard(params: DealListParams, enabled = true) {
  const { currentWorkspaceId } = useWorkspace();
  const { stage: _stage, sort: _sort, limit: _limit, ...filters } = params;
  return useQuery({
    queryKey: keys.dealBoard(currentWorkspaceId, filters),
    queryFn: ({ signal }) => backend.deals.board(filters, signal),
    enabled: Boolean(currentWorkspaceId) && enabled,
  });
}

export function useDeal(id: string | null | undefined) {
  const { currentWorkspaceId } = useWorkspace();
  return useQuery({
    queryKey: keys.deal(currentWorkspaceId, id ?? ""),
    queryFn: ({ signal }) => backend.deals.get(id!, signal),
    enabled: Boolean(currentWorkspaceId && id),
  });
}

/** The deal feed, newest first; `kind` filters server-side (empty = all). */
export function useDealTimeline(dealId: string, kind: ActivityType[] = []) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCursorList(
    keys.dealTimeline(ws, dealId, { kind }),
    (cursor, signal) => backend.deals.timeline(dealId, kind, cursor, signal),
    Boolean(dealId),
  );
}

function useDealWrite<A, R>(fn: (arg: A) => Promise<R>) {
  const client = useQueryClient();
  const { currentWorkspaceId: ws } = useWorkspace();
  return useMutation({ mutationFn: fn, onSuccess: () => refreshDeal(client, ws) });
}

export const useCreateDeal = () =>
  useDealWrite((input: CreateDealInput) => backend.deals.create(input));
export const useUpdateDeal = () =>
  useDealWrite(({ id, input }: { id: string; input: UpdateDealInput }) =>
    backend.deals.update(id, input),
  );
/** POST /deals/:id/stage; the backend decides what is allowed and what happens to the contact. */
export const useMoveDealStage = () =>
  useDealWrite(({ id, ...input }: MoveDealStageInput & { id: string }) =>
    backend.deals.moveStage(id, input),
  );

/**
 * Contact picker search over GET /contacts: debounced, from 2 characters, top 8 by name.
 * With `companyId` it lists that company's contacts even before typing (first 20 by name).
 */
export function useContactSearch(input: string, companyId?: string) {
  const { currentWorkspaceId } = useWorkspace();
  const q = useDebouncedValue(input.trim(), SEARCH_DEBOUNCE_MS);
  const term = q.length >= SEARCH_MIN_CHARS ? q : undefined;
  return useQuery({
    queryKey: keys.contactSearch(currentWorkspaceId, term ?? "", companyId),
    queryFn: ({ signal }) =>
      backend.contacts.list(
        { q: term, companyId, sort: "name:asc", limit: companyId ? 20 : 8 },
        undefined,
        signal,
      ),
    enabled: Boolean(currentWorkspaceId) && (Boolean(term) || Boolean(companyId)),
    staleTime: 30_000,
  });
}
