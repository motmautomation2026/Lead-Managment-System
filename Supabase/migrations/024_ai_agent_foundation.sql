-- =============================================================================
-- Northbeam CRM -- AI agent foundation (Feature 3A): tables only, nothing sends
-- =============================================================================
--
-- agent_settings   one row per workspace (mode off/shadow/live, send window,
--                  touch limits, word limits, opt-out texts). Seeded for every
--                  existing workspace and by an AFTER INSERT trigger on
--                  workspaces, so createWorkspace needs no change.
-- agent_playbooks  versioned free-text playbook per workspace (append-only).
-- agent_wakeups    queue of "look at this lead again" events for the worker.
-- agent_decisions  every decision the agent made, its validation, cost and
--                  outcome (shadow decisions are drafts; nothing is sent).
-- leads.agent_*    per-lead agent state and touch counters.
-- task_origin      + 'agent' (handoff tasks; 'automation' requires a workflow
--                  run). Not used anywhere in this migration: a value added by
--                  ALTER TYPE cannot be used in the same transaction.
--
-- Timeline: agent events use actor_source 'automation' + actor_name 'AI Agent';
-- the actor_source check is unchanged.
--
-- Additive and idempotent. RLS on, no policies (the backend bypasses RLS).
-- =============================================================================

alter type public.task_origin add value if not exists 'agent';

-- ---------------------------------------------------------------------------
-- agent_settings
-- ---------------------------------------------------------------------------
create table if not exists public.agent_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  mode text not null default 'off' check (mode in ('off', 'shadow', 'live')),
  -- ISO weekdays, Mon=1 .. Sun=7. The window is Asia/Kolkata local time.
  send_days int[] not null default '{1,2,3,4,5,6}'
    check (cardinality(send_days) > 0 and send_days <@ array[1,2,3,4,5,6,7]),
  send_window_start time not null default '09:30',
  send_window_end time not null default '19:00',
  min_gap_hours int not null default 48 check (min_gap_hours > 0),
  max_touches_7d int not null default 2 check (max_touches_7d > 0),
  max_touches_total int not null default 8 check (max_touches_total > 0),
  email_max_words int not null default 250 check (email_max_words > 0),
  whatsapp_max_words int not null default 80 check (whatsapp_max_words > 0),
  wake_min_days int not null default 1 check (wake_min_days > 0),
  wake_max_days int not null default 30 check (wake_max_days > 0),
  nurture_long_term boolean not null default false,
  monthly_budget_usd numeric(10,2) not null default 100 check (monthly_budget_usd > 0),
  decision_model text,
  grounding_model text,
  email_opt_out_text text not null default 'If you''d prefer not to hear from us, just reply "stop".'
    check (length(trim(email_opt_out_text)) > 0),
  whatsapp_opt_out_text text not null default 'Reply STOP to opt out.'
    check (length(trim(whatsapp_opt_out_text)) > 0),
  current_playbook_version int,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_settings_window_order check (send_window_start < send_window_end),
  constraint agent_settings_wake_order check (wake_min_days <= wake_max_days)
);

drop trigger if exists agent_settings_set_updated_at on public.agent_settings;
create trigger agent_settings_set_updated_at
  before update on public.agent_settings
  for each row execute function public.set_updated_at();

alter table public.agent_settings enable row level security;

comment on table public.agent_settings is
  'Per-workspace AI agent settings. mode: off (nothing), shadow (drafts only, sends nothing), live. '
  'decision_model / grounding_model NULL = use the env default.';

insert into public.agent_settings (workspace_id)
select id from public.workspaces
on conflict (workspace_id) do nothing;

create or replace function public.seed_agent_settings_for_workspace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.agent_settings (workspace_id) values (new.id)
  on conflict (workspace_id) do nothing;
  return new;
end;
$$;

drop trigger if exists workspaces_seed_agent_settings on public.workspaces;
create trigger workspaces_seed_agent_settings
  after insert on public.workspaces
  for each row execute function public.seed_agent_settings_for_workspace();

-- ---------------------------------------------------------------------------
-- agent_playbooks
-- ---------------------------------------------------------------------------
create table if not exists public.agent_playbooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  version int not null check (version > 0),
  body text not null check (length(trim(body)) > 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  constraint agent_playbooks_workspace_version_unique unique (workspace_id, version)
);

alter table public.agent_playbooks enable row level security;

-- ---------------------------------------------------------------------------
-- agent_wakeups
-- ---------------------------------------------------------------------------
create table if not exists public.agent_wakeups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  due_at timestamptz not null,
  reason text not null check (reason in (
    'lead_created', 'call_logged', 'note_added', 'meeting_booked', 'meeting_rescheduled',
    'meeting_cancelled', 'meeting_outcome', 'proposal_status', 'timer', 'enrolled',
    'manual_wake', 'resumed'
  )),
  payload jsonb,
  status text not null default 'pending' check (status in ('pending', 'executing', 'done', 'cancelled')),
  attempt_count int not null default 0 check (attempt_count >= 0),
  claimed_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists agent_wakeups_pending_due_idx on public.agent_wakeups (due_at) where status = 'pending';
create index if not exists agent_wakeups_lead_status_idx on public.agent_wakeups (lead_id, status);

alter table public.agent_wakeups enable row level security;

-- ---------------------------------------------------------------------------
-- agent_decisions
-- ---------------------------------------------------------------------------
create table if not exists public.agent_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  wakeup_id uuid references public.agent_wakeups (id) on delete set null,
  mode text not null check (mode in ('shadow', 'live')),

  action text not null check (action in ('send_email', 'send_whatsapp', 'wait', 'handoff', 'update_stage', 'stop')),
  reasoning text,
  message_subject text,
  message_body text,
  asset_ids uuid[],
  send_at timestamptz,
  next_wake_at timestamptz,
  handoff_title text,
  handoff_urgency text check (handoff_urgency in ('low', 'normal', 'high')),
  new_stage text,
  stop_reason text,

  rules_result jsonb,
  grounding_result jsonb,
  regenerated boolean not null default false,
  chunk_ids uuid[],

  playbook_version int,
  decision_model text,
  grounding_model text,
  input_tokens int,
  output_tokens int,
  cost_usd numeric(10,4),

  outcome text not null check (outcome in ('draft', 'sent', 'skipped', 'blocked', 'executed', 'failed')),
  error text,

  rating text check (rating in ('good', 'bad')),
  rating_note text,
  rated_by uuid references public.profiles (id) on delete set null,
  rated_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists agent_decisions_workspace_created_idx on public.agent_decisions (workspace_id, created_at desc);
create index if not exists agent_decisions_lead_created_idx on public.agent_decisions (lead_id, created_at desc);
create index if not exists agent_decisions_workspace_outcome_idx on public.agent_decisions (workspace_id, outcome);

alter table public.agent_decisions enable row level security;

-- ---------------------------------------------------------------------------
-- leads: per-lead agent state
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists agent_status text not null default 'none'
    check (agent_status in ('none', 'active', 'paused', 'handed_off', 'stopped')),
  add column if not exists agent_status_reason text,
  add column if not exists agent_status_changed_at timestamptz,
  add column if not exists agent_touch_count int not null default 0,
  add column if not exists agent_last_touch_at timestamptz;

create index if not exists leads_workspace_agent_status_idx on public.leads (workspace_id, agent_status);

comment on column public.leads.agent_status is
  'AI agent state for this lead: none (never enrolled), active, paused, handed_off, stopped. '
  'Independent of lifecycle_state, pipeline_stage and automation_mode.';
