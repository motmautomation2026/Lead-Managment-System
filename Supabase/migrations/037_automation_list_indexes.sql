-- Northbeam CRM -- C6b: keyset indexes for the Runs and Scheduled steps lists
-- (GET /runs/list, GET /scheduled-actions/list; docs/crm-v2/B4-api.md §7b).
-- Additive and re-runnable.

create index if not exists workflow_runs_workspace_started_idx
  on public.workflow_runs (workspace_id, started_at, id);

create index if not exists scheduled_actions_workspace_scheduled_idx
  on public.scheduled_actions (workspace_id, scheduled_for, id);
