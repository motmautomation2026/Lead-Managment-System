/**
 * C6b data layer: Runs and Scheduled steps lists (list standard), run actions, the
 * workflows reference list and the Home summary.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backend } from "@/lib/backend-client";
import type { RunListParams, ScheduledActionListParams } from "@/types";
import { keys, refreshContact } from "./query";
import { useCursorList } from "./server-hooks";
import { useWorkspace } from "./workspace-context";

/** /count takes the list's filters without sort/limit. */
function filtersOnly<P extends { sort?: string | undefined; limit?: number | undefined }>(
  params: P,
) {
  const { sort: _sort, limit: _limit, ...filters } = params;
  return filters;
}

export function useRunList(params: RunListParams, enabled = true) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCursorList(
    keys.runList(ws, params),
    (cursor, signal) => backend.runs.page(params, cursor, signal),
    enabled,
  );
}

export function useRunCount(params: RunListParams, enabled = true) {
  const { currentWorkspaceId: ws } = useWorkspace();
  const filters = filtersOnly(params);
  return useQuery({
    queryKey: keys.runCount(ws, filters),
    queryFn: ({ signal }) => backend.runs.count(filters, signal),
    enabled: Boolean(ws) && enabled,
  });
}

export function useScheduledActionList(params: ScheduledActionListParams, enabled = true) {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useCursorList(
    keys.scheduledActionList(ws, params),
    (cursor, signal) => backend.scheduledActions.page(params, cursor, signal),
    enabled,
  );
}

export function useScheduledActionCount(params: ScheduledActionListParams, enabled = true) {
  const { currentWorkspaceId: ws } = useWorkspace();
  const filters = filtersOnly(params);
  return useQuery({
    queryKey: keys.scheduledActionCount(ws, filters),
    queryFn: ({ signal }) => backend.scheduledActions.count(filters, signal),
    enabled: Boolean(ws) && enabled,
  });
}

export type RunAction = "pause" | "resume" | "cancel" | "retry";

/** Pause / resume / cancel / retry: refreshes runs, steps, workflow counts and the contact (B31). */
export function useRunAction() {
  const client = useQueryClient();
  const { currentWorkspaceId: ws } = useWorkspace();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: RunAction }) =>
      action === "pause"
        ? backend.runs.pause(id)
        : action === "resume"
          ? backend.runs.resume(id)
          : action === "cancel"
            ? backend.runs.cancel(id)
            : backend.runs.retry(id),
    onSuccess: (run) =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.workflows(ws) }),
        refreshContact(client, ws, run.leadId),
      ]),
  });
}

/** Every workflow of the workspace (a small reference list: names for filters and pickers). */
export function useWorkflowList() {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useQuery({
    queryKey: keys.workflows(ws),
    queryFn: ({ signal }) => backend.workflows.list(signal),
    enabled: Boolean(ws),
  });
}

export function useHomeSummary() {
  const { currentWorkspaceId: ws } = useWorkspace();
  return useQuery({
    queryKey: keys.home(ws),
    queryFn: ({ signal }) => backend.home.summary(signal),
    enabled: Boolean(ws),
  });
}
