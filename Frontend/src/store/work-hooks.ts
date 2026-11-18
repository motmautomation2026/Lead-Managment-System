/**
 * C6a data layer: Tasks, Meetings and Proposals lists (list standard), counts, the proposal
 * summary, and the writes behind the work pages and dialogs. Every write calls `refreshWork`.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  backend,
  type CreateMeetingInput,
  type CreateProposalInput,
  type CreateTaskInput,
  type UpdateMeetingInput,
  type UpdateProposalInput,
  type UpdateTaskInput,
} from "@/lib/backend-client";
import { sendingPollInterval } from "@/lib/proposal-sending";
import type {
  LeadLossReason,
  MeetingListParams,
  MeetingOutcome,
  ProposalListParams,
  ProposalStatus,
  TaskListItem,
  TaskListParams,
} from "@/types";
import { keys, refreshWork } from "./query";
import { useCursorList } from "./server-hooks";
import { useWorkspace } from "./workspace-context";

/** /count and /summary take the list's filters without sort/limit. */
function filtersOnly<P extends { sort?: string | undefined; limit?: number | undefined }>(
  params: P,
) {
  const { sort: _sort, limit: _limit, ...filters } = params;
  return filters;
}

export function useTaskList(params: TaskListParams, enabled = true) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCursorList(
    keys.workList(ws, "tasks", params),
    (cursor, signal) => backend.tasks.page(params, cursor, signal),
    enabled,
  );
}

export function useTaskCount(params: TaskListParams, enabled = true) {
  const { currentWorkspaceId: ws } = useWorkspace();
  const filters = filtersOnly(params);
  return useQuery({
    queryKey: keys.workCount(ws, "tasks", filters),
    queryFn: ({ signal }) => backend.tasks.count(filters, signal),
    enabled: Boolean(ws) && enabled,
  });
}

export function useMeetingList(params: MeetingListParams, enabled = true) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCursorList(
    keys.workList(ws, "meetings", params),
    (cursor, signal) => backend.meetings.page(params, cursor, signal),
    enabled,
  );
}

export function useMeetingCount(params: MeetingListParams, enabled = true) {
  const { currentWorkspaceId: ws } = useWorkspace();
  const filters = filtersOnly(params);
  return useQuery({
    queryKey: keys.workCount(ws, "meetings", filters),
    queryFn: ({ signal }) => backend.meetings.count(filters, signal),
    enabled: Boolean(ws) && enabled,
  });
}

/** Polls (8 s) while a loaded row's WhatsApp send is in flight, for at most 2 minutes per row (B19). */
export function useProposalList(params: ProposalListParams, enabled = true) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useInfiniteQuery({
    queryKey: keys.workList(ws, "proposals", params),
    queryFn: ({ pageParam, signal }) => backend.proposals.page(params, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(ws) && enabled,
    refetchInterval: (q) => sendingPollInterval(q.state.data?.pages.flatMap((p) => p.data) ?? []),
  });
}

export function useProposalCount(params: ProposalListParams, enabled = true) {
  const { currentWorkspaceId: ws } = useWorkspace();
  const filters = filtersOnly(params);
  return useQuery({
    queryKey: keys.workCount(ws, "proposals", filters),
    queryFn: ({ signal }) => backend.proposals.count(filters, signal),
    enabled: Boolean(ws) && enabled,
  });
}

export function useProposalSummary(params: ProposalListParams) {
  const { currentWorkspaceId: ws } = useWorkspace();
  const filters = filtersOnly(params);
  return useQuery({
    queryKey: keys.proposalSummary(ws, filters),
    queryFn: ({ signal }) => backend.proposals.summary(filters, signal),
    enabled: Boolean(ws),
  });
}

function useWorkWrite<A, R>(fn: (arg: A) => Promise<R>) {
  const client = useQueryClient();
  const { currentWorkspaceId: ws } = useWorkspace();
  return useMutation({ mutationFn: fn, onSuccess: () => refreshWork(client, ws) });
}

export const useCreateTask = () =>
  useWorkWrite((input: CreateTaskInput) => backend.tasks.create(input));
export const useUpdateTask = () =>
  useWorkWrite(({ id, input }: { id: string; input: UpdateTaskInput }) =>
    backend.tasks.update(id, input),
  );
export const useCancelTask = () =>
  useWorkWrite(({ id, reason }: { id: string; reason?: string | undefined }) =>
    backend.tasks.cancel(id, reason),
  );

type TaskPages = InfiniteData<{ data: TaskListItem[]; nextCursor: string | null }>;

/** Completes a task optimistically in every loaded task list; restores them if the request fails. */
export function useCompleteTask() {
  const client = useQueryClient();
  const { currentWorkspaceId: ws } = useWorkspace();
  const lists = ["work", ws, "tasks", "list"];
  return useMutation({
    mutationFn: (id: string) => backend.tasks.complete(id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: lists });
      const snapshot = client.getQueriesData<TaskPages>({ queryKey: lists });
      client.setQueriesData<TaskPages>({ queryKey: lists }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                data: page.data.map((t) =>
                  t.id === id ? { ...t, status: "completed" as const, done: true } : t,
                ),
              })),
            }
          : data,
      );
      return { snapshot };
    },
    onError: (_error, _id, context) => {
      context?.snapshot.forEach(([key, data]) => client.setQueryData(key, data));
    },
    onSuccess: () => refreshWork(client, ws),
  });
}

/** UX-3: Undo for Complete. */
export const useReopenTask = () => useWorkWrite((id: string) => backend.tasks.reopen(id));

export const useCreateMeeting = () =>
  useWorkWrite((input: CreateMeetingInput) => backend.meetings.create(input));
export const useUpdateMeeting = () =>
  useWorkWrite(({ id, input }: { id: string; input: UpdateMeetingInput }) =>
    backend.meetings.update(id, input),
  );
export const useRecordMeetingOutcome = () =>
  useWorkWrite(
    ({ id, outcome, notes }: { id: string; outcome: MeetingOutcome; notes?: string | undefined }) =>
      backend.meetings.recordOutcome(id, outcome, notes),
  );

export const useCreateProposal = () =>
  useWorkWrite((input: CreateProposalInput) => backend.proposals.create(input));
export const useUpdateProposal = () =>
  useWorkWrite(({ id, input }: { id: string; input: UpdateProposalInput }) =>
    backend.proposals.update(id, input),
  );
export const useSetProposalStatus = () =>
  useWorkWrite(
    ({
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
  );
