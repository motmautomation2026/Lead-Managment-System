-- =============================================================================
-- Northbeam CRM -- E4b: users assigned to workspaces (membership, per-workspace role, super-admin)
-- =============================================================================
--
-- workspace_members         one row per (workspace, user): the user's role IN THAT workspace
--                           ('admin' | 'salesperson', the same values as profiles.role). Every
--                           workspace-scoped API request checks it (requireWorkspace).
-- profiles.is_super_admin   opens every workspace with admin rights and manages every membership.
--                           Set only by `npm run admin:set-super-admin`, never by the UI.
-- workspace_member_events   audit of every membership change (who, what, when).
--
-- Backfill (rule 8, behaviour unchanged on deploy): every ACTIVE user becomes a member of every
-- existing workspace except `[test] …` ones, with their current global role. Deactivated users
-- get nothing. Additive and re-runnable: the backfill only runs while workspace_members is empty,
-- so a re-run never re-adds members that management removed afterwards.
-- RLS on with no policies: the browser never reads these tables (only the backend does).
-- =============================================================================

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint workspace_members_role_valid check (role in ('admin', 'salesperson')),
  constraint workspace_members_unique unique (workspace_id, user_id)
);
create index if not exists workspace_members_user_idx on public.workspace_members (user_id, workspace_id);
create index if not exists workspace_members_workspace_role_idx on public.workspace_members (workspace_id, role);
alter table public.workspace_members enable row level security;

comment on table public.workspace_members is
  'E4b: which users may open which workspace, and their role there. Checked by the API on every workspace request.';

alter table public.profiles add column if not exists is_super_admin boolean not null default false;
comment on column public.profiles.is_super_admin is
  'E4b: opens every workspace as admin and manages memberships. Set only by npm run admin:set-super-admin.';
comment on column public.profiles.role is
  'E4b: the global role is only the default for the 055 backfill and gates /admin user management; workspace roles live in workspace_members.';

create table if not exists public.workspace_member_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  action text not null,
  old_role text,
  new_role text,
  actor_id uuid references public.profiles (id) on delete set null,
  actor_email text not null,
  created_at timestamptz not null default now(),
  constraint workspace_member_events_action_valid check (action in ('added', 'role_changed', 'removed', 'workspace_created'))
);
create index if not exists workspace_member_events_workspace_idx on public.workspace_member_events (workspace_id, created_at desc);
alter table public.workspace_member_events enable row level security;

-- Rule 8 backfill: only while the table is empty (first apply).
insert into public.workspace_members (workspace_id, user_id, role)
select w.id, p.id, p.role
  from public.workspaces w
  cross join public.profiles p
 where p.is_active
   and w.name not like '[test] %'
   and not exists (select 1 from public.workspace_members)
on conflict (workspace_id, user_id) do nothing;
