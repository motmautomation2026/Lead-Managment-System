-- =============================================================================
-- Northbeam CRM -- Tasks, Meetings, Proposals lists (C6a)
-- =============================================================================
--
-- GET /tasks/list, /meetings/list and /proposals/list follow the CRM v2 list
-- standard (Backend/src/lists/listQuery.ts): every whitelisted sort needs a
-- (workspace_id, field, id) index. Saved views gain the three objects.
-- Additive and re-runnable.

create index if not exists tasks_workspace_due_idx on public.tasks (workspace_id, due_at, id);
create index if not exists tasks_workspace_created_idx on public.tasks (workspace_id, created_at, id);
create index if not exists tasks_workspace_updated_idx on public.tasks (workspace_id, updated_at, id);

create index if not exists meetings_workspace_scheduled_idx on public.meetings (workspace_id, scheduled_at, id);
create index if not exists meetings_workspace_created_idx on public.meetings (workspace_id, created_at, id);

create index if not exists proposals_workspace_updated_idx on public.proposals (workspace_id, updated_at, id);
create index if not exists proposals_workspace_sent_idx on public.proposals (workspace_id, sent_at, id);
create index if not exists proposals_workspace_amount_idx on public.proposals (workspace_id, amount, id);

alter table public.saved_views drop constraint if exists saved_views_object_valid;
alter table public.saved_views add constraint saved_views_object_valid
  check (object in ('contacts', 'companies', 'deals', 'tasks', 'meetings', 'proposals'));
